import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";

// Only hexadecimal identities may be case folded. Solana and Canton are case sensitive.
export function ccipAddressKey(value: string) {
  return /^0x[0-9a-f]+$/i.test(value) ? `0x${BigInt(value).toString(16)}` : value;
}

export function isCcipAddress(family: string, value: string) {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  switch (family) {
    case "EVM": return isAddress(value) && BigInt(value) !== BigInt(0);
    case "APTOS": return /^0x[0-9a-f]{1,64}$/i.test(value) && BigInt(value) !== BigInt(0);
    case "SOLANA":
      try { return new PublicKey(value).toBase58() === value && value !== "11111111111111111111111111111111"; }
      catch { return false; }
    case "CANTON": return /^[\w.-]+::1220[0-9a-fA-F]{64}$/.test(value);
    default: return false;
  }
}

export function isCcipTransactionHash(family: string, value: string) {
  if (family === "SOLANA") {
    // A Solana signature encodes 64 bytes, not a 32-byte account public key.
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
    let n = BigInt(0);
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (const c of value) n = n * BigInt(58) + BigInt(alphabet.indexOf(c));
    const zeros = value.match(/^1*/)?.[0].length ?? 0;
    const bytes = n === BigInt(0) ? 0 : Math.ceil(n.toString(16).length / 2);
    return zeros + bytes === 64;
  }
  if (family === "CANTON") return /^(?:1220[0-9a-f]{64}|[A-Za-z0-9_-]{43,128}={0,2})$/.test(value);
  return /^(EVM|APTOS)$/.test(family) && /^0x[0-9a-f]{64}$/i.test(value);
}
