import { keccak256, pad, recoverAddress, zeroHash, type Hex } from "viem";
import { assertCctpTransfer, cctpEvm, type CctpTransfer } from "./cctp-evm";

// V2 header (148 bytes) + burn body (228 bytes), no hooks in EVM transfers.
// https://developers.circle.com/cctp/references/technical-guide
export function parseCctpMessage(message: unknown) {
  if (typeof message !== "string" || !/^0x[\da-f]{752}$/i.test(message)) throw new Error("Invalid CCTP V2 burn message.");
  const part = (start: number, length: number) => `0x${message.slice(2 + start * 2, 2 + (start + length) * 2)}` as Hex;
  const number = (start: number, length = 4) => BigInt(part(start, length));
  if (number(0) !== BigInt(1) || number(148) !== BigInt(1)) throw new Error("Unsupported CCTP message version.");
  return {
    sourceDomain: Number(number(4)), destinationDomain: Number(number(8)), nonce: part(12, 32),
    sender: part(44, 32), recipient: part(76, 32), destinationCaller: part(108, 32),
    minFinality: Number(number(140)), finality: Number(number(144)),
    burnToken: part(152, 32), mintRecipient: part(184, 32), amount: number(216, 32),
    messageSender: part(248, 32), maxFee: number(280, 32), fee: number(312, 32), expirationBlock: number(344, 32),
  };
}

export function assertCctpMessage(message: Hex, t: CctpTransfer, attested: boolean) {
  assertCctpTransfer(t);
  const m = parseCctpMessage(message);
  const source = cctpEvm(t.sourceDomain), destination = cctpEvm(t.destinationDomain);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (m.sourceDomain !== t.sourceDomain || m.destinationDomain !== t.destinationDomain ||
      !same(m.sender, pad(source.messenger)) || !same(m.recipient, pad(destination.messenger)) ||
      !same(m.burnToken, pad(source.usdc as Hex)) || !same(m.mintRecipient, pad(t.recipient as Hex)) ||
      !same(m.messageSender, pad(t.sender as Hex)) || m.destinationCaller !== zeroHash ||
      m.amount !== BigInt(t.amount) || m.maxFee !== BigInt(t.maxFee) || m.minFinality !== t.finality || m.fee > m.maxFee ||
      (attested && (![1000, 2000].includes(m.finality) || m.finality < m.minFinality || m.nonce === zeroHash))) {
    throw new Error("CCTP message does not match the original transfer.");
  }
  if (attested) {
    if (!t.sourceMessage) throw new Error("Source burn receipt must be verified before claiming.");
    // Iris assigns nonce/finality/fee/expiry offchain; every immutable byte must
    // still match the MessageSent event fetched from the source-chain receipt.
    const immutable = (hex: Hex) => [hex.slice(2, 26), hex.slice(90, 290), hex.slice(298, 626)].join("").toLowerCase();
    if (immutable(message) !== immutable(t.sourceMessage)) throw new Error("Attestation is for a different source burn.");
  }
  return m;
}

export async function cctpAttesters(message: Hex, attestation: Hex): Promise<string[]> {
  if (!/^0x(?:[\da-f]{130}){1,20}$/i.test(attestation)) throw new Error("Invalid Circle attestation signatures.");
  const addresses: string[] = [];
  for (let offset = 2; offset < attestation.length; offset += 130) {
    const address = (await recoverAddress({ hash: keccak256(message), signature: `0x${attestation.slice(offset, offset + 130)}` })).toLowerCase();
    if (addresses.length && BigInt(address) <= BigInt(addresses[addresses.length - 1])) throw new Error("Circle attesters must be unique and ordered.");
    addresses.push(address);
  }
  return addresses;
}

export function selectCctpAttestation(data: unknown, transfer: CctpTransfer): { message: Hex; attestation: Hex } | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as { messages?: unknown }).messages)) throw new Error("Invalid Circle message response.");
  const entries = (data as { messages: Array<Record<string, unknown>> }).messages;
  const matches: Array<{ message: Hex; attestation: Hex }> = [];
  for (const item of entries) {
    if (item.status !== "complete" || item.cctpVersion !== 2 || typeof item.message !== "string" || typeof item.attestation !== "string") continue;
    try { assertCctpMessage(item.message as Hex, transfer, true); } catch { continue; }
    if (!/^0x(?:[\da-f]{130}){1,20}$/i.test(item.attestation)) throw new Error("Circle returned an invalid attestation.");
    matches.push({ message: item.message as Hex, attestation: item.attestation as Hex });
  }
  if (matches.length > 1) throw new Error("Multiple attestations match this burn; automatic claiming is unavailable.");
  if (!matches.length && entries.some(item => item.status === "complete")) throw new Error("Circle attestation does not match the source burn.");
  return matches[0] ?? null;
}
