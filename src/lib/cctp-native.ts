import { hexToBytes, pad, toHex, zeroHash, type Hex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StrKey } from "@stellar/stellar-sdk";
import { cctpNetwork } from "./cctp";
import { normalizeCctpRecipient } from "./cctp-recipients";

// Amount and maxFee are always CCTP wire units (six decimals). Stellar adapters
// scale these explicitly to seven decimals; input dust must stay in the wallet.
export interface CctpNativeIntent {
  sourceDomain: number; destinationDomain: number;
  sender: string; recipient: string; amount: string; maxFee: string; finality: 1000 | 2000;
}
export const CCTP_SOLANA = {
  messenger: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  transmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
};
export const CCTP_STELLAR = {
  messenger: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
  transmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
  forwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
};
export function cctpUint(value: string, bits = 256) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= (BigInt(1) << BigInt(bits))) throw new Error(`Invalid CCTP u${bits} amount.`);
  return BigInt(value);
}
export function validateCctpNativeIntent(t: CctpNativeIntent, sourceDomain?: number) {
  const source = cctpNetwork(t.sourceDomain), destination = cctpNetwork(t.destinationDomain);
  if (sourceDomain !== undefined && sourceDomain !== t.sourceDomain || source.domain === destination.domain) throw new Error("CCTP network mismatch.");
  normalizeCctpRecipient(source.family, t.sender);
  normalizeCctpRecipient(destination.family, t.recipient);
  const width = (family: string) => ["SOLANA", "APTOS", "SUI"].includes(family) ? 64 : family === "STELLAR" ? 123 : 256;
  const bits = Math.min(width(source.family), width(destination.family));
  const amount = cctpUint(t.amount, bits), maxFee = cctpUint(t.maxFee, bits);
  if (!amount || maxFee >= amount || ![1000, 2000].includes(t.finality) || t.finality === 1000 && !source.fastSource) throw new Error("Invalid CCTP amount, fee or finality.");
  return { source, destination, amount, maxFee };
}
export function cctpMintTarget(domain: number, recipient: string): { mintRecipient: Hex; destinationCaller: Hex; hook: Hex } {
  const network = cctpNetwork(domain);
  const normalized = normalizeCctpRecipient(network.family, recipient);
  if (network.family === "SOLANA") {
    // Circle mints to an SPL account, never to the wallet's system account.
    const ata = getAssociatedTokenAddressSync(new PublicKey(network.usdc), new PublicKey(normalized), true);
    return { mintRecipient: toHex(ata.toBytes()), destinationCaller: zeroHash, hook: "0x" };
  }
  if (network.family === "STELLAR") {
    const target = toHex(StrKey.decodeContract(CCTP_STELLAR.forwarder));
    // Official forwarder format: 24 reserved zero bytes, u32 version 0,
    // u32 UTF-8 recipient length, then the entire typed G/C/M address.
    const bytes = Buffer.from(normalized, "utf8"), hook = Buffer.alloc(32 + bytes.length);
    hook.writeUInt32BE(bytes.length, 28); bytes.copy(hook, 32);
    return { mintRecipient: target, destinationCaller: target, hook: toHex(hook) };
  }
  return { mintRecipient: pad(normalized as Hex), destinationCaller: zeroHash, hook: "0x" };
}
export function nativeCctpBurnArgs(t: CctpNativeIntent, sourceDomain: number) {
  const values = validateCctpNativeIntent(t, sourceDomain);
  return { ...values, ...cctpMintTarget(t.destinationDomain, t.recipient) };
}
export function cctpProofBytes(message: Hex, attestation: Hex, destinationDomain: number) {
  if (!/^0x[\da-f]+$/i.test(message) || message.length % 2 || message.length < 754 || message.length > 16_386 ||
      !/^0x(?:[\da-f]{130}){1,20}$/i.test(attestation)) throw new Error("Invalid CCTP message or attestation encoding.");
  const bytes = Buffer.from(hexToBytes(message));
  if (bytes.readUInt32BE(0) !== 1 || bytes.readUInt32BE(148) !== 1 || bytes.readUInt32BE(8) !== destinationDomain ||
      bytes.subarray(12, 44).every(b => b === 0)) throw new Error("CCTP proof destination, version or nonce mismatch.");
  return { message: bytes, attestation: Buffer.from(hexToBytes(attestation)) };
}

// Non-EVM hashes are not interchangeable with EVM hashes. Validate before
// persisting or constructing an Iris query; never lowercase base58 values.
export function isCctpNativeHash(domain: number, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const family = cctpNetwork(domain).family;
  if (family === "STELLAR") return /^[\da-f]{64}$/i.test(value);
  if (family === "SOLANA" || family === "SUI") {
    try {
      // bs58 is intentionally avoided: viem does not decode base58, while the
      // public key decoder is exactly 32 bytes and is suitable for Sui digests.
      if (family === "SUI") return new PublicKey(value).toBase58() === value;
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      if (value.length < 64 || value.length > 88) return false;
      let n = BigInt(0);
      for (const c of value) { const digit = alphabet.indexOf(c); if (digit < 0) return false; n = n * BigInt(58) + BigInt(digit); }
      const leading = value.match(/^1*/)?.[0].length ?? 0;
      return leading + (n === BigInt(0) ? 0 : Math.ceil(n.toString(16).length / 2)) === 64;
    } catch { return false; }
  }
  return /^0x[\da-f]{64}$/i.test(value) && (family !== "STARKNET" || BigInt(value) < BigInt(2) ** BigInt(251));
}
