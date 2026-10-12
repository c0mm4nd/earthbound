import { AccountAddress, MoveVector, TransactionPayloadScript, Script, U32, U64 } from "@aptos-labs/ts-sdk";
import { hexToBytes, type Hex } from "viem";
import { CCTP_APTOS_SCRIPTS } from "./cctp-aptos-bytecode";
import { nativeCctpBurnArgs, type CctpNativeIntent } from "./cctp-native";
import { assertCctpNativeDestination } from "./cctp-native-proof";

export function cctpAptosBurnPayload(t: CctpNativeIntent) {
  const a = nativeCctpBurnArgs(t, 9);
  const args = [new U64(a.amount), new U32(t.destinationDomain), AccountAddress.from(a.mintRecipient),
    AccountAddress.from(a.destinationCaller), AccountAddress.from(a.source.usdc), new U64(a.maxFee), new U32(t.finality)];
  const withHook = a.hook !== "0x";
  return new TransactionPayloadScript(new Script(hexToBytes(CCTP_APTOS_SCRIPTS[withHook ? "deposit_for_burn_with_hook" : "deposit_for_burn"]), [],
    withHook ? [...args, MoveVector.U8(hexToBytes(a.hook))] : args));
}
export function cctpAptosClaimPayload(recipient: string, message: Hex, attestation: Hex) {
  const proof = assertCctpNativeDestination(9, recipient, message, attestation);
  return new TransactionPayloadScript(new Script(hexToBytes(CCTP_APTOS_SCRIPTS.receive_message), [], [MoveVector.U8(proof.message), MoveVector.U8(proof.attestation)]));
}
