import { PublicKey } from "@solana/web3.js";
import { encodeAbiParameters, keccak256, padHex, stringToHex, toHex, zeroAddress, type Hex } from "viem";
import { isCcipAddress } from "./ccip-addresses";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
export function ccipReceiverBytes(family: string, receiver: string): Hex {
  if (!isCcipAddress(family, receiver)) throw new Error("Invalid CCIP receiver.");
  if (family === "SOLANA") return toHex(new PublicKey(receiver).toBytes());
  if (family === "CANTON") return keccak256(stringToHex(receiver));
  return padHex(`0x${receiver.slice(2).padStart(64, "0")}` as Hex, { size: 32 });
}

// Source families use different serialization even for identically named structs.
// GenericExtraArgsV2: EVM ABI u256; Aptos BCS u256 LE; Solana Borsh u128 LE.
export function ccipMessageEncoding(sourceFamily: string, destinationFamily: string, receiver: string) {
  const recipient = ccipReceiverBytes(destinationFamily, receiver);
  if (destinationFamily === "CANTON") {
    if (sourceFamily !== "EVM") throw new Error("This source has no configured Canton lane.");
    // GenericExtraArgsV3, finalized, default CCVs/executor, no callback/data.
    return { receiver: recipient, extraArgs: `0xa69dd4aa${"00".repeat(4 + 4 + 1 + 1 + 2 + 1 + 2)}` as Hex };
  }
  if (destinationFamily === "SOLANA") {
    const extraArgs = sourceFamily === "EVM"
      ? `0x1f3b3aba${encodeAbiParameters([{ type: "tuple", components: [
        { name: "computeUnits", type: "uint32" }, { name: "accountIsWritableBitmap", type: "uint64" },
        { name: "allowOutOfOrderExecution", type: "bool" }, { name: "tokenReceiver", type: "bytes32" }, { name: "accounts", type: "bytes32[]" },
      ] }], [{ computeUnits: 0, accountIsWritableBitmap: BigInt(0), allowOutOfOrderExecution: true, tokenReceiver: recipient, accounts: [] }]).slice(2)}`
      : sourceFamily === "APTOS"
        ? `0x1f3b3aba${"00".repeat(12)}0120${recipient.slice(2)}00`
        : undefined;
    if (!extraArgs) throw new Error("Unsupported CCIP Solana destination encoding.");
    // Pure token delivery: no receiver program invocation. Recipient is in extraArgs.
    return { receiver: ZERO32, extraArgs: extraArgs as Hex };
  }
  const extraArgs = sourceFamily === "EVM"
    ? `0x181dcf10${encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [BigInt(0), true]).slice(2)}`
    : sourceFamily === "SOLANA" || sourceFamily === "APTOS"
      ? `0x181dcf10${"00".repeat(sourceFamily === "SOLANA" ? 16 : 32)}01`
      : undefined;
  if (!extraArgs) throw new Error("Unsupported CCIP source message encoding.");
  return { receiver: recipient, extraArgs: extraArgs as Hex };
}

export function ccipNativeFeeToken(family: string) {
  if (family === "SOLANA") return "11111111111111111111111111111111";
  if (family === "APTOS") return "0xa";
  if (family === "EVM") return zeroAddress;
  throw new Error("Canton requires a configured fee instrument.");
}
