import { Deserializer, TransactionPayload, TransactionPayloadScript } from "@aptos-labs/ts-sdk";
import { CCTP_APTOS_SCRIPTS } from "./cctp-aptos-bytecode";

/** JSON transports BCS, then reconstructs the SDK's typed script arguments. */
export function cctpAptosWalletPayload(encoded: string) {
  if (!/^0x(?:[\da-f]{2}){1,20000}$/i.test(encoded)) throw new Error("Invalid CCTP script encoding.");
  const decoder = new Deserializer(new Uint8Array(Buffer.from(encoded.slice(2), "hex")));
  const payload = TransactionPayload.deserialize(decoder);
  if (!(payload instanceof TransactionPayloadScript) || payload.bcsToHex().toString().toLowerCase() !== encoded.toLowerCase()) throw new Error("Invalid CCTP script payload.");
  const bytecode = `0x${Buffer.from(payload.script.bytecode).toString("hex")}`;
  if (!Object.values(CCTP_APTOS_SCRIPTS).includes(bytecode as typeof CCTP_APTOS_SCRIPTS.deposit_for_burn)) throw new Error("Unrecognized CCTP mainnet script.");
  return { data: { bytecode: payload.script.bytecode, typeArguments: payload.script.type_args, functionArguments: payload.script.args } };
}
