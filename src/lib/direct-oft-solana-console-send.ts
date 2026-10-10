import { Buffer } from "buffer";
import {
  PublicKey, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type Connection, type AccountMeta, type AddressLookupTableAccount,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount, getMemoTransfer } from "@solana/spl-token";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { hexToBytes, sha256, stringToBytes, toHex } from "viem";
import type { LayerZeroOftV2SendParam, LayerZeroMessagingFee } from "./custom-oft";
import type { DirectOftAdapter } from "./direct-oft-types";
import { Reader, type decodeConsoleOftStore } from "./direct-oft-solana-console";
import { CONSOLE_OFT_PROGRAM_ID } from "./solana-oft-programs";

// Matches console_oft quote_oft / quote_send / send in the issuer's source.
// Execute the deployed quote instructions so pause, fee and rate-limit semantics
// remain authoritative on chain. No API transaction or platform fee is used.
const PROGRAM = new PublicKey(CONSOLE_OFT_PROGRAM_ID);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
function le(value: bigint | number, size: number) {
  const bytes = Buffer.alloc(size);
  if (size === 8) bytes.writeBigUInt64LE(BigInt(value)); else bytes.writeUIntLE(Number(value), 0, size);
  return bytes;
}
function be(value: number, size: number) {
  const bytes = Buffer.alloc(size);
  bytes.writeUIntBE(value, size - Math.min(size, 4), Math.min(size, 4));
  return bytes;
}
export function encodeConsoleOftInstruction(name: "quote_oft" | "quote_send" | "quote" | "send", value: LayerZeroOftV2SendParam, fee?: LayerZeroMessagingFee) {
  if (value.composeMsg !== "0x" || value.oftCmd !== "0x") throw new Error("Console OFT supports single-hop sends without compose only.");
  if (value.amountLD <= BigInt(0) || value.amountLD > U64_MAX || value.minAmountLD < BigInt(0) || value.minAmountLD > value.amountLD)
    throw new Error("Invalid Console OFT send amount.");
  const recipient = hexToBytes(value.to), options = hexToBytes(value.extraOptions);
  if (recipient.length !== 32) throw new Error("Invalid Console OFT recipient.");
  if (name === "send" && (!fee || fee.nativeFee < BigInt(0) || fee.nativeFee > U64_MAX || fee.lzTokenFee !== BigInt(0)))
    throw new Error("Invalid Console OFT native fee.");
  return Buffer.concat([
    Buffer.from(hexToBytes(sha256(stringToBytes(`global:${name}`))).subarray(0, 8)),
    le(value.dstEid, 4), Buffer.from(recipient), le(value.amountLD, 8), le(value.minAmountLD, 8),
    le(options.length, 4), Buffer.from(options), Buffer.from([0]), // compose: None
    ...(name === "send" ? [le(fee!.nativeFee, 8), le(fee!.lzTokenFee, 8)] : [Buffer.from([0])]),
  ]);
}
export function decodeConsoleOftQuote(bytes: Uint8Array, feeBytes: 8 | 16 = 16) {
  const b = Buffer.from(bytes);
  if (b.length < 36) throw new Error("Truncated Console OFT quote result.");
  const minAmountLD = b.readBigUInt64LE(0), maxAmountLD = b.readBigUInt64LE(8), count = b.readUInt32LE(16);
  if (count > 16) throw new Error("Invalid Console OFT quote fees.");
  let offset = 20;
  for (let i = 0; i < count; i++) {
    if (offset + feeBytes + 4 > b.length) throw new Error("Truncated Console OFT quote fee.");
    const length = b.readUInt32LE(offset + feeBytes);
    offset += feeBytes + 4 + length;
  }
  if (offset + 16 !== b.length) throw new Error("Invalid Console OFT quote result layout.");
  return { minAmountLD, maxAmountLD, amountSentLD: b.readBigUInt64LE(offset), amountReceivedLD: b.readBigUInt64LE(offset + 8) };
}

export async function createConsoleOftSource(args: {
  connection: Connection; storeKey: PublicKey; store: ReturnType<typeof decodeConsoleOftStore>;
  peerKey: PublicKey; peer: `0x${string}`; escrowKey: PublicKey; lookups: AddressLookupTableAccount[];
  from: string; remoteEid: number; simulate: boolean;
}): Promise<Pick<DirectOftAdapter, "enforcedOptions" | "quoteOft" | "quoteSend" | "buildSteps">> {
  const { connection, storeKey, store, peerKey, escrowKey, remoteEid } = args;
  const owner = new PublicKey(args.from);
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("Console OFT source must be a signing wallet.");
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM);
  const routePda = (name: string, eid = remoteEid) => pda(stringToBytes(name), storeKey.toBytes(), be(eid, 16))[0];
  const pause = routePda("Pause"), feeConfig = routePda("Fee"), defaults = routePda("RateLimit", 0), rate = routePda("RateLimit");
  const exempt = pda(stringToBytes("RateLimitExemption"), storeKey.toBytes(), owner.toBytes())[0];
  const [optionsKey, optionsBump] = pda(stringToBytes("EnforcedOptions"), storeKey.toBytes(), be(remoteEid, 4), be(1, 2));
  const optionsRaw = await connection.getAccountInfo(optionsKey);
  let enforcedOptions: `0x${string}` = "0x";
  if (optionsRaw?.data.length) {
    if (!optionsRaw.owner.equals(PROGRAM) || optionsRaw.executable) throw new Error("Invalid Console OFT enforced-options owner.");
    const reader = new Reader(optionsRaw.data, "EnforcedOptions");
    enforcedOptions = toHex(reader.bytes(reader.u32()));
    if (reader.u8() !== optionsBump) throw new Error("Invalid Console OFT enforced-options PDA.");
    reader.end();
  }
  const validate = (value: LayerZeroOftV2SendParam) => {
    if (value.dstEid !== remoteEid) throw new Error("Console OFT destination changed.");
    return value;
  };
  const instruction = (name: "quote_oft" | "quote_send" | "send", value: LayerZeroOftV2SendParam, keys: AccountMeta[], fee?: LayerZeroMessagingFee) =>
    new TransactionInstruction({ programId: PROGRAM, keys, data: encodeConsoleOftInstruction(name, validate(value), fee) });
  const transaction = async (ix: TransactionInstruction) => {
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix],
    }).compileToV0Message(args.lookups));
    if (tx.message.header.numRequiredSignatures !== 1) throw new Error("Unexpected extra Console OFT signer.");
    if (tx.serialize().length > 1232) throw new Error("Console OFT transaction exceeds the packet size limit.");
    return { tx, blockhash };
  };
  const simulate = async (tx: VersionedTransaction) => {
    const { value } = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (value.err) throw new Error(`Console OFT simulation failed: ${JSON.stringify(value.err)}. ${(value.logs ?? []).filter((line) => /Error|failed|insufficient|paused/i.test(line)).slice(-4).join(" ")}`);
    return value;
  };
  const quote = async (ix: TransactionInstruction) => {
    const result = await simulate((await transaction(ix)).tx);
    if (!result.returnData || result.returnData.programId !== PROGRAM.toBase58() || result.returnData.data[1] !== "base64")
      throw new Error("Console OFT quote returned no verified result.");
    return Buffer.from(result.returnData.data[0], "base64");
  };
  const endpoint = new EndpointProgram.Endpoint(EndpointProgram.PROGRAM_ID);
  const path = { sender: toHex(storeKey.toBytes()), dstEid: remoteEid, receiver: args.peer };
  const library = async () => {
    const info = await endpoint.getSendLibrary(connection, storeKey, remoteEid);
    if (!info?.programId) throw new Error("Console OFT send library is uninitialized or blocked.");
    const version = await endpoint.getMessageLibVersion(connection, owner, info.programId);
    if (version?.major.toString() !== "3" || version.minor !== 0 || version.endpointVersion !== 2)
      throw new Error("Unsupported Console OFT send library.");
    return new UlnProgram.Uln(info.programId);
  };
  return {
    enforcedOptions,
    quoteOft: async (value) => decodeConsoleOftQuote(await quote(instruction("quote_oft", value,
      [storeKey, pause, feeConfig, defaults, rate].map((key) => meta(key))))),
    quoteSend: async (value) => {
      const remaining = await endpoint.getQuoteIXAccountMetaForCPI(connection, owner, path, await library());
      const result = await quote(instruction("quote_send", value,
        [...[storeKey, peerKey, optionsKey, feeConfig].map((key) => meta(key)), ...remaining]));
      if (result.length !== 16) throw new Error("Invalid Console OFT messaging fee result.");
      return { nativeFee: result.readBigUInt64LE(0), lzTokenFee: result.readBigUInt64LE(8) };
    },
    buildSteps: async (value, fee) => {
      const ata = getAssociatedTokenAddressSync(store.mint, owner, false, store.tokenProgram);
      const raw = await connection.getAccountInfo(ata);
      if (!raw) throw new Error("Source Solana token account does not exist.");
      const source = unpackAccount(ata, raw, store.tokenProgram);
      if (!source.owner.equals(owner) || !source.mint.equals(store.mint) || !source.isInitialized || source.isFrozen || source.amount < value.amountLD)
        throw new Error("Source Solana token account is frozen or has insufficient balance.");
      const feeAccount = unpackAccount(store.feeDeposit, await connection.getAccountInfo(store.feeDeposit), store.tokenProgram);
      if (!feeAccount.mint.equals(store.mint) || !feeAccount.isInitialized || feeAccount.isFrozen || getMemoTransfer(feeAccount)?.requireIncomingTransferMemos)
        throw new Error("Invalid Console OFT fee deposit account.");
      const remaining = await endpoint.getSendIXAccountMetaForCPI(connection, owner, path, await library());
      const event = pda(stringToBytes("__event_authority"))[0];
      const ix = instruction("send", value, [meta(owner, false, true), meta(storeKey), meta(peerKey), meta(optionsKey),
        meta(pause), meta(feeConfig), meta(defaults, true), meta(rate, true), meta(exempt),
        meta(ata, true), meta(escrowKey, true), meta(store.feeDeposit, true), meta(store.mint, true), meta(store.tokenProgram),
        meta(event), meta(PROGRAM), ...remaining], fee);
      const { tx, blockhash } = await transaction(ix);
      if (args.simulate) await simulate(tx);
      return [{ type: "TRANSACTION", chainType: "SOLANA", chainKey: "solana", description: "Send directly via Console OFT",
        transaction: { encoded: { encoding: "base64", serializedTransaction: Buffer.from(tx.serialize()).toString("base64"), ...blockhash } } }];
    },
  };
}
