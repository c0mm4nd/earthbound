import { hexToBytes, pad, toHex, zeroHash, type Hex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StrKey } from "@stellar/stellar-sdk";
import { cctpNetwork } from "./cctp";
import { validateCctpNativeIntent, type CctpNativeIntent } from "./cctp-native-record";
export { cctpUint, validateCctpNativeIntent, isCctpNativeHash, type CctpNativeIntent } from "./cctp-native-record";
import { normalizeCctpRecipient } from "./cctp-recipients";

// Amount and maxFee are always CCTP wire units (six decimals). Stellar adapters
// scale these explicitly to seven decimals; input dust must stay in the wallet.
export const CCTP_SOLANA = {
  messenger: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  transmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
};
export const CCTP_STELLAR = {
  messenger: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
  transmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
  forwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
};
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
