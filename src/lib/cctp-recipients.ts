import { isAddress, getAddress } from "viem";
import { PublicKey } from "@solana/web3.js";
import { StrKey } from "@stellar/stellar-sdk";
import { CctpRequestError } from "./cctp";
import type { CctpFamily } from "./cctp-networks";

/** Validates a wallet recipient, NOT a CCTP mintRecipient or token account.
 * Solana token-account derivation and Stellar forwarder hooks belong to the
 * future execution adapters; never use these strings directly as burn arguments.
 */
export function normalizeCctpRecipient(family: CctpFamily, value: unknown): string {
  if (typeof value !== "string" || value.length > 128) throw new CctpRequestError("Invalid CCTP recipient.");
  if (family === "EVM") {
    if (isAddress(value) && BigInt(value) !== BigInt(0)) return getAddress(value);
  } else if (family === "SOLANA") {
    try {
      const key = new PublicKey(value);
      if (key.toBase58() === value && key.toBytes().some((byte) => byte !== 0)) return value;
    } catch { /* Fall through to the same user-facing validation error. */ }
  } else if (family === "STELLAR") {
    // Preserve G/C/M type and muxed account ID; raw bytes32 would lose them.
    if (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value) || StrKey.isValidMed25519PublicKey(value)) return value;
  } else if (["APTOS", "SUI", "STARKNET"].includes(family) && /^0x[\da-f]{1,64}$/i.test(value)) {
    const address = BigInt(value);
    const upperBound = family === "STARKNET" ? BigInt(2) ** BigInt(251) : BigInt(2) ** BigInt(256);
    if (address > BigInt(0) && address < upperBound) return `0x${address.toString(16).padStart(64, "0")}`;
  }
  throw new CctpRequestError(`Invalid ${family} recipient address.`);
}
