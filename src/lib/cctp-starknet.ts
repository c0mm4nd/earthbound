import { type Hex } from "viem";
import { nativeCctpBurnArgs, type CctpNativeIntent } from "./cctp-native";
import { assertCctpNativeDestination } from "./cctp-native-proof";

export const CCTP_STARKNET = {
  messenger: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
  transmitter: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
};
// Mainnet ABI: amount, mintRecipient, destinationCaller and maxFee are u256,
// not felts. Serialize low/high limbs without going through JS Number.
export function cctpCairoUint256(value: bigint) {
  if (value < BigInt(0) || value >= BigInt(2) ** BigInt(256)) throw new Error("Invalid Cairo u256.");
  return [(value & (BigInt(2) ** BigInt(128) - BigInt(1))).toString(), (value >> BigInt(128)).toString()];
}
export function cctpCairoBytes(bytes: Uint8Array): string[] {
  const data = Buffer.from(bytes), count = Math.floor(data.length / 31), result = [String(count)];
  for (let i = 0; i < count; i++) result.push(BigInt(`0x${data.subarray(i * 31, i * 31 + 31).toString("hex")}`).toString());
  const rest = data.subarray(count * 31);
  return [...result, rest.length ? BigInt(`0x${rest.toString("hex")}`).toString() : "0", String(rest.length)];
}
export function decodeCctpCairoBytes(values: string[]) {
  if (!Array.isArray(values) || !values.every(v => typeof v === "string" && /^(?:0x[\da-f]+|\d+)$/i.test(v))) throw new Error("Invalid Cairo ByteArray.");
  const count = Number(BigInt(values[0] ?? "0"));
  if (!Number.isSafeInteger(count) || count < 0 || count > 264 || values.length !== count + 3) throw new Error("Invalid Cairo ByteArray length.");
  const tailSize = Number(BigInt(values[count + 2]));
  if (tailSize < 0 || tailSize > 30 || BigInt(values[count + 1]) >= BigInt(2) ** BigInt(tailSize * 8)) throw new Error("Invalid Cairo pending bytes.");
  const words = values.slice(1, count + 1).map(v => {
    const n = BigInt(v); if (n >= BigInt(2) ** BigInt(248)) throw new Error("Invalid Cairo byte word.");
    return n.toString(16).padStart(62, "0");
  });
  if (tailSize) words.push(BigInt(values[count + 1]).toString(16).padStart(tailSize * 2, "0"));
  return `0x${words.join("")}` as Hex;
}
export function cctpStarknetBurnCalls(t: CctpNativeIntent) {
  const a = nativeCctpBurnArgs(t, 25);
  const hook = Buffer.from(a.hook.slice(2), "hex");
  return [
    { contractAddress: a.source.usdc, entrypoint: "approve", calldata: [CCTP_STARKNET.messenger, ...cctpCairoUint256(a.amount)] },
    { contractAddress: CCTP_STARKNET.messenger, entrypoint: hook.length ? "deposit_for_burn_with_hook" : "deposit_for_burn",
      calldata: [...cctpCairoUint256(a.amount), String(t.destinationDomain), ...cctpCairoUint256(BigInt(a.mintRecipient)), a.source.usdc,
        ...cctpCairoUint256(BigInt(a.destinationCaller)), ...cctpCairoUint256(a.maxFee), String(t.finality), ...(hook.length ? cctpCairoBytes(hook) : [])] },
  ];
}
export function cctpStarknetClaimCall(recipient: string, message: Hex, attestation: Hex) {
  const proof = assertCctpNativeDestination(25, recipient, message, attestation);
  return { contractAddress: CCTP_STARKNET.transmitter, entrypoint: "receive_message", calldata: [...cctpCairoBytes(proof.message), ...cctpCairoBytes(proof.attestation)] };
}
