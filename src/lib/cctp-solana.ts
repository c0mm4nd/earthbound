import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { toHex, type Hex } from "viem";
import { CCTP_SOLANA, cctpMintTarget, cctpProofBytes, nativeCctpBurnArgs, type CctpNativeIntent } from "./cctp-native";
import { cctpNetwork } from "./cctp";
import { assertCctpNativeMessage } from "./cctp-native-proof";
import { isCctpNativeHash } from "./cctp-native";
import type { TransactionUserStep } from "./bridge-types";

// Layout/account order verified against circlefin/solana-cctp-contracts at
// ec16e95d28ee47f7832df4203ae07b5981d146fc (V2 IDLs and Rust constraints).
export const SOLANA_CCTP_MT = new PublicKey(CCTP_SOLANA.transmitter);
export const SOLANA_CCTP_TMM = new PublicKey(CCTP_SOLANA.messenger);
const mint = new PublicKey(cctpNetwork(5).usdc);
export const cctpSolanaPda = (program: PublicKey, seed: string, ...extra: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...extra], program)[0];
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const discriminator = (kind: "account" | "global", name: string) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
const vector = (bytes: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length); return Buffer.concat([size, bytes]); };

export function cctpSolanaBurnInstruction(t: CctpNativeIntent, eventAccount: PublicKey) {
  const args = nativeCctpBurnArgs(t, 5), owner = new PublicKey(t.sender);
  const data = Buffer.alloc(88);
  data.writeBigUInt64LE(args.amount, 0); data.writeUInt32LE(t.destinationDomain, 8);
  Buffer.from(args.mintRecipient.slice(2), "hex").copy(data, 12);
  Buffer.from(args.destinationCaller.slice(2), "hex").copy(data, 44);
  data.writeBigUInt64LE(args.maxFee, 76); data.writeUInt32LE(t.finality, 84);
  const hook = Buffer.from(args.hook.slice(2), "hex");
  const pda = (seed: string, ...extra: Buffer[]) => cctpSolanaPda(SOLANA_CCTP_TMM, seed, ...extra);
  return new TransactionInstruction({ programId: SOLANA_CCTP_TMM,
    data: Buffer.concat([discriminator("global", hook.length ? "deposit_for_burn_with_hook" : "deposit_for_burn"), data, ...(hook.length ? [vector(hook)] : [])]),
    keys: [meta(owner, false, true), meta(owner, true, true), meta(pda("sender_authority")),
      meta(getAssociatedTokenAddressSync(mint, owner), true), meta(pda("denylist_account", owner.toBuffer())),
      meta(cctpSolanaPda(SOLANA_CCTP_MT, "message_transmitter"), true), meta(pda("token_messenger")),
      meta(pda("remote_token_messenger", Buffer.from(String(t.destinationDomain)))), meta(pda("token_minter")),
      meta(pda("local_token", mint.toBuffer()), true), meta(mint, true), meta(eventAccount, true, true),
      meta(SOLANA_CCTP_MT), meta(SOLANA_CCTP_TMM), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      meta(pda("__event_authority")), meta(SOLANA_CCTP_TMM)],
  });
}

export function cctpSolanaClaimInstructions(recipient: string, payer: string, feeRecipient: PublicKey, message: Hex, attestation: Hex) {
  const proof = cctpProofBytes(message, attestation, 5), target = cctpMintTarget(5, recipient);
  if (toHex(proof.message.subarray(184, 216)) !== target.mintRecipient ||
      !proof.message.subarray(76, 108).equals(SOLANA_CCTP_TMM.toBuffer()) ||
      !proof.message.subarray(108, 140).every(b => b === 0) || proof.message.length !== 376) throw new Error("Solana CCTP recipient or receiver mismatch.");
  const owner = new PublicKey(recipient), caller = new PublicKey(payer), tokenAccount = new PublicKey(Buffer.from(target.mintRecipient.slice(2), "hex"));
  const domain = Buffer.from(String(proof.message.readUInt32BE(4)));
  const pda = (seed: string, ...extra: Buffer[]) => cctpSolanaPda(SOLANA_CCTP_TMM, seed, ...extra);
  const receive = new TransactionInstruction({ programId: SOLANA_CCTP_MT,
    data: Buffer.concat([discriminator("global", "receive_message"), vector(proof.message), vector(proof.attestation)]),
    keys: [meta(caller, true, true), meta(caller, false, true), meta(cctpSolanaPda(SOLANA_CCTP_MT, "message_transmitter_authority", SOLANA_CCTP_TMM.toBuffer())),
      meta(cctpSolanaPda(SOLANA_CCTP_MT, "message_transmitter")), meta(cctpSolanaPda(SOLANA_CCTP_MT, "used_nonce", proof.message.subarray(12, 44)), true),
      meta(SOLANA_CCTP_TMM), meta(SystemProgram.programId), meta(cctpSolanaPda(SOLANA_CCTP_MT, "__event_authority")), meta(SOLANA_CCTP_MT),
      meta(pda("token_messenger")), meta(pda("remote_token_messenger", domain)), meta(pda("token_minter")),
      meta(pda("local_token", mint.toBuffer()), true), meta(pda("token_pair", domain, proof.message.subarray(152, 184))),
      meta(getAssociatedTokenAddressSync(mint, feeRecipient, true), true), meta(tokenAccount, true), meta(pda("custody", mint.toBuffer()), true),
      meta(TOKEN_PROGRAM_ID), meta(pda("__event_authority")), meta(SOLANA_CCTP_TMM)],
  });
  return [createAssociatedTokenAccountIdempotentInstruction(caller, tokenAccount, owner, mint), receive];
}

export function decodeCctpSolanaEvent(data: Buffer): Hex {
  if (data.length < 52 || !data.subarray(0, 8).equals(discriminator("account", "MessageSent"))) throw new Error("Invalid Circle Solana message account.");
  const size = data.readUInt32LE(48);
  if (size < 376 || size > 8192 || data.length !== 52 + size) throw new Error("Invalid Circle Solana message length.");
  return toHex(data.subarray(52));
}
export function decodeCctpSolanaMessenger(data: Buffer) {
  if (data.length < 177 || !data.subarray(0, 8).equals(discriminator("account", "TokenMessenger")) || data.readUInt32LE(104) !== 1) throw new Error("Invalid Solana CCTP messenger state.");
  return { feeRecipient: new PublicKey(data.subarray(109, 141)) };
}

export function decodeCctpSolanaAttesters(data: Buffer) {
  if (data.length < 153 || !data.subarray(0, 8).equals(discriminator("account", "MessageTransmitter")) ||
      data[136] !== 0 || data.readUInt32LE(137) !== 5 || data.readUInt32LE(141) !== 1) throw new Error("Solana CCTP transmitter is unavailable, paused or on the wrong domain.");
  const threshold = data.readUInt32LE(145), count = data.readUInt32LE(149);
  if (threshold < 1 || threshold > count || count > 100 || data.length < 153 + count * 32 + 8) throw new Error("Invalid Solana CCTP attester set.");
  const enabledAttesters = Array.from({ length: count }, (_, i) => {
    const key = data.subarray(153 + i * 32, 185 + i * 32);
    if (!key.subarray(0, 12).every(b => b === 0)) throw new Error("Invalid Circle EVM attester address.");
    return toHex(key.subarray(12));
  });
  return { domain: 5, threshold, enabledAttesters };
}
async function assertSolanaCctpMainnet(connection: Connection) {
  if (await connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("CCTP requires Solana mainnet.");
}
export async function readCctpSolanaAttesters(connection: Connection) {
  await assertSolanaCctpMainnet(connection);
  const account = await connection.getAccountInfo(cctpSolanaPda(SOLANA_CCTP_MT, "message_transmitter"), "confirmed");
  if (!account?.owner.equals(SOLANA_CCTP_MT)) throw new Error("Solana CCTP transmitter account is unavailable.");
  return decodeCctpSolanaAttesters(account.data);
}
export async function readCctpSolanaNonce(connection: Connection, nonce: Hex) {
  if (!/^0x[\da-f]{64}$/i.test(nonce) || BigInt(nonce) === BigInt(0)) throw new Error("Invalid CCTP nonce.");
  await assertSolanaCctpMainnet(connection);
  const account = await connection.getAccountInfo(cctpSolanaPda(SOLANA_CCTP_MT, "used_nonce", Buffer.from(nonce.slice(2), "hex")), "confirmed");
  if (!account) return false;
  if (!account.owner.equals(SOLANA_CCTP_MT) || account.data.length !== 9 ||
      !account.data.subarray(0, 8).equals(discriminator("account", "UsedNonce")) || account.data[8] !== 1) throw new Error("Invalid CCTP consumed-nonce account.");
  return true;
}
export async function readCctpSolanaBurn(connection: Connection, t: CctpNativeIntent, hash: string, eventAccount: string) {
  nativeCctpBurnArgs(t, 5);
  if (!isCctpNativeHash(5, hash)) throw new Error("Invalid Solana burn signature.");
  const eventKey = new PublicKey(eventAccount);
  await assertSolanaCctpMainnet(connection);
  const receipt = await connection.getTransaction(hash, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!receipt) return { state: "pending" as const };
  if (receipt.transaction.signatures[0] !== hash || !receipt.meta) throw new Error("Solana source receipt identity mismatch.");
  if (receipt.meta.err) return { state: "failed" as const };
  const tx = receipt.transaction.message;
  const keys = tx.getAccountKeys({ accountKeysFromLookups: receipt.meta.loadedAddresses });
  const burn = cctpSolanaBurnInstruction(t, eventKey);
  // Only the direct, locally constructed CCTP instruction is supported. Tie
  // the message account and all burn bytes to this exact source transaction.
  const match = tx.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)?.equals(SOLANA_CCTP_TMM) &&
    Buffer.from(ix.data).equals(burn.data) && ix.accountKeyIndexes.length === burn.keys.length &&
    burn.keys.every((key, i) => keys.get(ix.accountKeyIndexes[i])?.equals(key.pubkey)));
  if (match.length !== 1) throw new Error("Solana receipt does not contain the reviewed CCTP burn.");
  const event = await connection.getAccountInfo(eventKey, "confirmed");
  if (!event?.owner.equals(SOLANA_CCTP_MT)) throw new Error("Circle message account is unavailable; it may have been reclaimed.");
  const message = decodeCctpSolanaEvent(event.data);
  assertCctpNativeMessage(t, message, false);
  return { state: "confirmed" as const, message };
}

async function solanaCctpStep(connection: Connection, payer: PublicKey, instructions: TransactionInstruction[], signer?: Keypair): Promise<TransactionUserStep> {
  await assertSolanaCctpMainnet(connection);
  const validity = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: validity.blockhash, instructions }).compileToV0Message());
  if (signer) tx.sign([signer]);
  if (tx.serialize().length > 1232) throw new Error("CCTP transaction exceeds the Solana packet limit.");
  return { type: "TRANSACTION", chainType: "SOLANA", chainKey: "solana", description: signer ? "Burn USDC with Circle CCTP" : "Claim CCTP USDC",
    transaction: { encoded: { cctp: true, encoding: "base64", serializedTransaction: Buffer.from(tx.serialize()).toString("base64"), ...validity } } };
}
export async function buildCctpSolanaBurn(connection: Connection, intent: CctpNativeIntent) {
  const event = Keypair.generate();
  return { eventAccount: event.publicKey.toBase58(), step: await solanaCctpStep(connection, new PublicKey(intent.sender), [cctpSolanaBurnInstruction(intent, event.publicKey)], event) };
}
export async function buildCctpSolanaClaim(connection: Connection, recipient: string, payer: string, message: Hex, attestation: Hex) {
  const account = await connection.getAccountInfo(cctpSolanaPda(SOLANA_CCTP_TMM, "token_messenger"), "confirmed");
  if (!account?.owner.equals(SOLANA_CCTP_TMM)) throw new Error("Circle Solana messenger is unavailable.");
  const { feeRecipient } = decodeCctpSolanaMessenger(account.data);
  const [prepare, claim] = cctpSolanaClaimInstructions(recipient, payer, feeRecipient, message, attestation);
  // Two Circle signatures plus all receive accounts leave only six bytes in
  // the packet. Create the idempotent ATA separately, then confirm it before
  // asking the wallet to submit the claim. Preparation is not a mint.
  return {
    prepare: await solanaCctpStep(connection, new PublicKey(payer), [prepare]),
    claim: await solanaCctpStep(connection, new PublicKey(payer), [claim]),
  };
}
