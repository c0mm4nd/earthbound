import { Buffer } from "buffer";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type Connection, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getAssociatedTokenAddressSync, getMemoTransfer } from "@solana/spl-token";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { stringToBytes, toHex, type Hex } from "viem";
import type { BridgeToken, LayerZeroOftListDeployment } from "./bridge-types";
import type { DirectOftAdapter } from "./direct-oft-types";
import type { LayerZeroOftV2SendParam, LayerZeroMessagingFee } from "./custom-oft";
import { Reader } from "./direct-oft-solana-console";
import { encodeConsoleOftInstruction, decodeConsoleOftQuote } from "./direct-oft-solana-console-send";
import { solanaOftTokenAccountSize } from "./solana-token-extensions";
import { SOLANA_OFT_LOOKUP_TABLE, solanaRentExtraOptions } from "./direct-oft-solana";

// LayerZero-v2/solana/programs/programs/oft: legacy OftConfig / Peer layout.
// Its seed is "Oft" (case sensitive), native tokens burn directly from the ATA,
// and the fee quote instruction is "quote", not modern "quote_send".
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
export function decodeLegacyOftStore(data: Uint8Array) {
  if (data.length !== 179) throw new Error("Unsupported legacy OFT store allocation.");
  const r = new Reader(data, "OftConfig");
  const rate = r.u64(), mint = r.key(), tokenProgram = r.key(), endpoint = r.key(), bump = r.u8(), admin = r.key(), type = r.u8();
  if (type > 1) throw new Error("Unsupported legacy OFT custody type.");
  const authority = type === 0 && r.bool() ? r.key() : null;
  const escrow = type === 1 ? r.key() : null;
  r.end(32); // A cleared Option can leave old bytes in the fixed allocation.
  return { rate, mint, tokenProgram, endpoint, bump, admin, type, authority, escrow };
}
export function decodeLegacyOftPeer(data: Uint8Array) {
  const r = new Reader(data, "Peer"), peer = toHex(r.bytes(32));
  const limit = r.bool() ? { capacity: r.u64(), tokens: r.u64(), refill: r.u64(), updated: r.u64() } : null;
  const bump = r.u8(); r.end(32);
  return { peer, limit, bump };
}
export function legacyOftCapacity(limit: ReturnType<typeof decodeLegacyOftPeer>["limit"], now: bigint) {
  if (!limit) return U64_MAX;
  const refill = now > limit.updated ? (now - limit.updated) * limit.refill : BigInt(0);
  const available = limit.tokens + refill;
  return available < limit.capacity ? available : limit.capacity;
}
export async function createLegacySolanaOftAdapter(args: {
  connection: Connection; storeKey: PublicKey; storeRaw: AccountInfo<Buffer>; token: BridgeToken;
  deployment: LayerZeroOftListDeployment; remoteEid: number; from?: string; simulate: boolean;
}): Promise<DirectOftAdapter> {
  const { connection, storeKey, storeRaw, remoteEid } = args, program = storeRaw.owner;
  if (storeRaw.executable || (args.deployment.details?.oftProgramId && args.deployment.details.oftProgramId !== program.toBase58()))
    throw new Error("Legacy Solana OFT program does not match metadata.");
  const store = decodeLegacyOftStore(storeRaw.data);
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program);
  const [expected, bump] = pda(stringToBytes("Oft"), (store.escrow ?? store.mint).toBytes());
  if (!expected.equals(storeKey) || bump !== store.bump || store.mint.toBase58() !== args.token.address)
    throw new Error("Legacy OFT store PDA or mint does not match the selected token.");
  if ((!store.tokenProgram.equals(TOKEN_PROGRAM_ID) && !store.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) || !store.endpoint.equals(EndpointProgram.PROGRAM_ID))
    throw new Error("Unsupported legacy OFT token program or endpoint.");
  const eid = Buffer.alloc(4); eid.writeUInt32BE(remoteEid);
  const [peerKey, peerBump] = pda(stringToBytes("Peer"), storeKey.toBytes(), eid);
  const [optionsKey, optionsBump] = pda(stringToBytes("EnforcedOptions"), storeKey.toBytes(), eid);
  const [programRaw, mintRaw, peerRaw, optionsRaw] = await connection.getMultipleAccountsInfo([program, store.mint, peerKey, optionsKey]);
  if (!programRaw?.executable) throw new Error("Legacy OFT program is not executable.");
  const owned = (raw: AccountInfo<Buffer> | null) => {
    if (!raw || raw.executable || !raw.owner.equals(program)) throw new Error("Legacy OFT peer or options account is missing or invalid.");
    return raw.data;
  };
  const peer = decodeLegacyOftPeer(owned(peerRaw));
  if (peer.bump !== peerBump || /^0x0{64}$/.test(peer.peer)) throw new Error("Invalid legacy OFT peer.");
  let enforcedOptions: Hex = "0x";
  // Receiving does not require a local send-options account.
  if (optionsRaw) {
    const r = new Reader(owned(optionsRaw), "EnforcedOptions");
    enforcedOptions = toHex(r.bytes(r.u32())); r.bytes(r.u32());
    if (r.u8() !== optionsBump) throw new Error("Invalid legacy OFT options PDA.");
    r.end(1536);
  }
  const mint = unpackMint(store.mint, mintRaw, store.tokenProgram);
  if (!mint.isInitialized || mint.decimals !== args.token.decimals) throw new Error("Legacy OFT mint decimals do not match the selected token.");
  const size = solanaOftTokenAccountSize(mint, store.tokenProgram);
  let rate = store.rate, exponent = 0;
  while (rate > BigInt(1) && rate % BigInt(10) === BigInt(0)) { rate /= BigInt(10); exponent++; }
  if (rate !== BigInt(1) || exponent > mint.decimals) throw new Error("Invalid legacy OFT decimal conversion rate.");
  if (!store.escrow && !mint.mintAuthority?.equals(storeKey)) throw new Error("Legacy OFT mint authority does not match the store.");
  const validTokenAccount = async (address: PublicKey, owner: PublicKey) => {
    const raw = await connection.getAccountInfo(address);
    if (!raw) return null;
    const token = unpackAccount(address, raw, store.tokenProgram);
    if (!token.owner.equals(owner) || !token.mint.equals(store.mint) || !token.isInitialized || token.isFrozen || getMemoTransfer(token)?.requireIncomingTransferMemos)
      throw new Error("Legacy OFT token account is invalid, frozen or requires a memo.");
    return token;
  };
  const payer = () => { if (!args.from) throw new Error("Solana source wallet is required."); return new PublicKey(args.from); };
  const endpoint = new EndpointProgram.Endpoint(store.endpoint);
  const path = { sender: toHex(storeKey.toBytes()), dstEid: remoteEid, receiver: peer.peer };
  const library = async () => {
    const info = await endpoint.getSendLibrary(connection, storeKey, remoteEid);
    if (!info?.programId) throw new Error("Legacy OFT send library is not configured.");
    const version = await endpoint.getMessageLibVersion(connection, payer(), info.programId);
    if (version?.major.toString() !== "3" || version.minor !== 0 || version.endpointVersion !== 2) throw new Error("Unsupported legacy OFT send library.");
    return new UlnProgram.Uln(info.programId);
  };
  const ix = (name: "send" | "quote" | "quote_oft", value: LayerZeroOftV2SendParam, keys: AccountMeta[], fee?: LayerZeroMessagingFee) => {
    if (value.dstEid !== remoteEid) throw new Error("Legacy OFT destination changed.");
    return new TransactionInstruction({ programId: program, keys, data: encodeConsoleOftInstruction(name, value, fee) });
  };
  const transaction = async (instruction: TransactionInstruction) => {
    const lookup = (await connection.getAddressLookupTable(new PublicKey(SOLANA_OFT_LOOKUP_TABLE))).value;
    if (!lookup?.isActive()) throw new Error("Solana OFT lookup table is unavailable.");
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer(), recentBlockhash: blockhash.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), instruction],
    }).compileToV0Message([lookup]));
    if (tx.message.header.numRequiredSignatures !== 1 || tx.serialize().length > 1232) throw new Error("Invalid legacy OFT transaction signers or size.");
    return { tx, blockhash };
  };
  const simulate = async (tx: VersionedTransaction) => {
    const { value } = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (value.err) throw new Error(`Legacy OFT simulation failed: ${JSON.stringify(value.err)}. ${(value.logs ?? []).filter((line) => /Error|failed|insufficient/i.test(line)).slice(-4).join(" ")}`);
    return value;
  };
  const quote = async (instruction: TransactionInstruction) => {
    const result = await simulate((await transaction(instruction)).tx);
    if (!result.returnData || result.returnData.programId !== program.toBase58() || result.returnData.data[1] !== "base64")
      throw new Error("Legacy OFT quote returned no verified result.");
    return Buffer.from(result.returnData.data[0], "base64");
  };
  return {
    addressBytes32: toHex(storeKey.toBytes()), tokenAddress: store.mint.toBase58(), decimals: mint.decimals,
    sharedDecimals: mint.decimals - exponent, peer: peer.peer, enforcedOptions,
    receiveOptions: async (recipient, options) => {
      const owner = new PublicKey(recipient), ata = getAssociatedTokenAddressSync(store.mint, owner, true, store.tokenProgram);
      if (await validTokenAccount(ata, owner)) return "0x";
      return solanaRentExtraOptions(BigInt(await connection.getMinimumBalanceForRentExemption(size)), options);
    },
    validateReceive: async (_, amount) => {
      if (amount <= BigInt(0) || amount > U64_MAX) throw new Error("Legacy OFT receive amount exceeds integer limits.");
      if (store.escrow) {
        const escrow = await validTokenAccount(store.escrow, storeKey);
        if (!escrow || escrow.amount < amount) throw new Error("Legacy OFT destination escrow has insufficient liquidity.");
      } else if (mint.supply + amount > U64_MAX) throw new Error("Legacy OFT receive amount exceeds mint supply limits.");
    },
    quoteOft: async (value) => {
      const receipt = decodeConsoleOftQuote(await quote(ix("quote_oft", value, [storeKey, peerKey, store.mint].map((key) => meta(key)))), 8);
      if (peer.limit) {
        const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
        if (!clock || clock.data.length !== 40) throw new Error("Solana chain clock is unavailable.");
        const capacity = legacyOftCapacity(peer.limit, clock.data.readBigInt64LE(32));
        if (receipt.amountSentLD > capacity) throw new Error("Amount exceeds the legacy OFT outbound rate limit.");
      }
      return receipt;
    },
    quoteSend: async (value) => {
      const remaining = await endpoint.getQuoteIXAccountMetaForCPI(connection, payer(), path, await library());
      const bytes = await quote(ix("quote", value, [...[storeKey, peerKey, optionsKey, store.mint].map((key) => meta(key)), ...remaining]));
      if (bytes.length !== 16) throw new Error("Invalid legacy OFT messaging fee.");
      return { nativeFee: bytes.readBigUInt64LE(0), lzTokenFee: bytes.readBigUInt64LE(8) };
    },
    buildSteps: async (value, fee) => {
      const owner = payer(), ata = getAssociatedTokenAddressSync(store.mint, owner, false, store.tokenProgram);
      const source = await validTokenAccount(ata, owner);
      if (!source || source.amount < value.amountLD) throw new Error("Source Solana token account has insufficient balance.");
      if (store.escrow && !await validTokenAccount(store.escrow, storeKey)) throw new Error("Legacy OFT escrow is missing.");
      const remaining = await endpoint.getSendIXAccountMetaForCPI(connection, owner, path, await library());
      const { tx, blockhash } = await transaction(ix("send", value, [meta(owner, false, true), meta(peerKey, true), meta(optionsKey), meta(storeKey),
        meta(ata, true), meta(store.escrow ?? program, Boolean(store.escrow)), meta(store.mint, true), meta(store.tokenProgram),
        meta(pda(stringToBytes("__event_authority"))[0]), meta(program), ...remaining], fee));
      if (args.simulate) await simulate(tx);
      return [{ type: "TRANSACTION", chainType: "SOLANA", chainKey: "solana", description: "Send directly via Solana OFT",
        transaction: { encoded: { encoding: "base64", serializedTransaction: Buffer.from(tx.serialize()).toString("base64"), ...blockhash } } }];
    },
  };
}
