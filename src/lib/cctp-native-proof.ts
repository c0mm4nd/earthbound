import { PublicKey } from "@solana/web3.js";
import { Asset, Networks, StrKey } from "@stellar/stellar-sdk";
import { keccak256, pad, stringToHex, toHex, type Hex } from "viem";
import { cctpEvm } from "./cctp-evm";
import { cctpNetwork } from "./cctp";
import { cctpAttesters } from "./cctp-message";
import { cctpMintTarget, cctpProofBytes, validateCctpNativeIntent, type CctpNativeIntent } from "./cctp-native";

// Cross-checked against Ethereum TokenMessengerV2.remoteTokenMessengers on
// 2026-10-12. Aptos uses the object's signer; Sui uses a witness-type hash.
const remoteMessengers: Record<number, Hex> = {
  5: "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893",
  8: "0xf47842a2b5ac4483731927a7500175a9354d2eccd94312aa591ec50b9e8657e6",
  9: pad("0x52f4732b1cb52ce28f595e29978450132772f88277182e12bc431faa677be603"),
  25: pad("0x07d421b9ca8aa32df259965cda8acb93f7599f69209a41872ae84638b2a20f2a"),
  27: "0x09a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded2",
};
export function cctpWireMessenger(domain: number): Hex {
  return remoteMessengers[domain] ?? pad(cctpEvm(domain).messenger);
}
export function cctpWireAddress(domain: number, value: string): Hex {
  const family = cctpNetwork(domain).family;
  if (family === "SOLANA") return toHex(new PublicKey(value).toBytes());
  if (family === "STELLAR") {
    if (StrKey.isValidEd25519PublicKey(value)) return toHex(StrKey.decodeEd25519PublicKey(value));
    if (StrKey.isValidContract(value)) return toHex(StrKey.decodeContract(value));
    throw new Error("A muxed Stellar address cannot be the burn signer.");
  }
  return pad(value as Hex).toLowerCase() as Hex;
}
export function cctpWireUsdc(domain: number): Hex {
  const network = cctpNetwork(domain);
  if (network.family === "SUI") return keccak256(stringToHex(network.usdc.slice(2)));
  if (network.family === "STELLAR") return cctpWireAddress(domain, new Asset("USDC", network.usdc.slice(5)).contractId(Networks.PUBLIC));
  return cctpWireAddress(domain, network.usdc);
}
export function assertCctpNativeDestination(domain: number, recipient: string, message: Hex, attestation: Hex) {
  const proof = cctpProofBytes(message, attestation, domain), target = cctpMintTarget(domain, recipient);
  const field = (offset: number) => toHex(proof.message.subarray(offset, offset + 32));
  if (field(76) !== cctpWireMessenger(domain) || field(184) !== target.mintRecipient || field(108) !== target.destinationCaller ||
      toHex(proof.message.subarray(376)) !== target.hook || BigInt(field(216)) === BigInt(0) ||
      BigInt(field(280)) >= BigInt(field(216)) || BigInt(field(312)) > BigInt(field(280))) throw new Error("CCTP destination, recipient, hook or fee mismatch.");
  return proof;
}
export function assertCctpNativeMessage(t: CctpNativeIntent, message: Hex, attested: boolean) {
  const { amount, maxFee } = validateCctpNativeIntent(t);
  if (!/^0x(?:[\da-f]{2}){376,8192}$/i.test(message)) throw new Error("Invalid CCTP source message.");
  const b = Buffer.from(message.slice(2), "hex"), hex = (offset: number, size = 32) => toHex(b.subarray(offset, offset + size));
  const target = cctpMintTarget(t.destinationDomain, t.recipient);
  if (b.readUInt32BE(0) !== 1 || b.readUInt32BE(148) !== 1 || b.readUInt32BE(4) !== t.sourceDomain || b.readUInt32BE(8) !== t.destinationDomain ||
      hex(44) !== cctpWireMessenger(t.sourceDomain) || hex(76) !== cctpWireMessenger(t.destinationDomain) ||
      hex(108) !== target.destinationCaller || hex(152) !== cctpWireUsdc(t.sourceDomain) || hex(184) !== target.mintRecipient ||
      BigInt(hex(216)) !== amount || hex(248) !== cctpWireAddress(t.sourceDomain, t.sender) || BigInt(hex(280)) !== maxFee ||
      b.readUInt32BE(140) !== t.finality || BigInt(hex(312)) > maxFee || toHex(b.subarray(376)) !== target.hook ||
      (attested && (BigInt(hex(12)) === BigInt(0) || ![1000, 2000].includes(b.readUInt32BE(144)) || b.readUInt32BE(144) < t.finality))) {
    throw new Error("CCTP proof does not match the reviewed native-USDC transfer.");
  }
  return { nonce: hex(12), fee: BigInt(hex(312)), expirationBlock: BigInt(hex(344)) };
}

export type CctpNativeProof = { message: Hex; attestation: Hex };
export async function verifyCctpNativeProof(t: CctpNativeIntent, sourceMessage: Hex, proof: CctpNativeProof, destination: {
  // Read from the destination's actual transmitter, after chain/domain checks.
  domain: number; threshold: number; enabledAttesters: string[];
}) {
  assertCctpNativeMessage(t, sourceMessage, false);
  cctpProofBytes(proof.message, proof.attestation, t.destinationDomain);
  const result = assertCctpNativeMessage(t, proof.message, true);
  const immutable = (hex: Hex) => [hex.slice(2, 26), hex.slice(90, 290), hex.slice(298, 626), hex.slice(754)].join("").toLowerCase();
  if (immutable(sourceMessage) !== immutable(proof.message)) throw new Error("Circle proof differs from the source receipt.");
  const signers = await cctpAttesters(proof.message, proof.attestation);
  const enabled = new Set(destination.enabledAttesters.map(a => BigInt(a).toString(16)));
  if (destination.domain !== t.destinationDomain || !Number.isSafeInteger(destination.threshold) || destination.threshold < 1 ||
      signers.length !== destination.threshold || signers.some(s => !enabled.has(BigInt(s).toString(16)))) throw new Error("Circle signatures do not match the destination attester set.");
  return result;
}
