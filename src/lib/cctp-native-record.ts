import { PublicKey } from "@solana/web3.js";
import type { Hex } from "viem";
import { cctpNetwork } from "./cctp";
import { normalizeCctpRecipient } from "./cctp-recipients";

export interface CctpNativeIntent {
  sourceDomain: number; destinationDomain: number;
  sender: string; recipient: string; amount: string; maxFee: string; finality: 1000 | 2000;
}
export type CctpNativeTransfer = CctpNativeIntent & {
  state: "preparing" | "burn_pending" | "attestation_pending" | "ready" | "claim_pending" | "complete" | "failed";
  burnHash?: string; claimHash?: string; sourceMessage?: Hex; eventAccount?: string;
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

export function assertCctpNativeTransfer(value: unknown): asserts value is CctpNativeTransfer {
  if (!value || typeof value !== "object") throw new Error("Invalid CCTP native record.");
  const t = value as CctpNativeTransfer;
  validateCctpNativeIntent(t);
  if (t.sourceMessage !== undefined && (typeof t.sourceMessage !== "string" || !/^0x(?:[\da-f]{2}){376,8192}$/i.test(t.sourceMessage))) throw new Error("Invalid CCTP source message.");
  if (t.eventAccount !== undefined && (t.sourceDomain !== 5 || typeof t.eventAccount !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.eventAccount))) throw new Error("Invalid Solana CCTP event account.");
  if (!["preparing", "burn_pending", "attestation_pending", "ready", "claim_pending", "complete", "failed"].includes(t.state) ||
      t.burnHash !== undefined && !isCctpNativeHash(t.sourceDomain, t.burnHash) ||
      t.claimHash !== undefined && !isCctpNativeHash(t.destinationDomain, t.claimHash)) throw new Error("Invalid CCTP native recovery record.");
}
