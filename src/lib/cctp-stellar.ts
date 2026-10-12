import { Address, Asset, Contract, Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { type Hex } from "viem";
import { CCTP_STELLAR, nativeCctpBurnArgs, type CctpNativeIntent } from "./cctp-native";
import { assertCctpNativeDestination } from "./cctp-native-proof";

const usdc = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").contractId(Networks.PUBLIC);
const bytes = (value: Hex) => xdr.ScVal.scvBytes(Buffer.from(value.slice(2), "hex"));
export const CCTP_STELLAR_USDC = usdc;
export function cctpStellarBurnOperations(t: CctpNativeIntent, expirationLedger: number) {
  const a = nativeCctpBurnArgs(t, 27);
  if (!StrKey.isValidEd25519PublicKey(t.sender)) throw new Error("Connect a Stellar account wallet to burn USDC.");
  if (!Number.isSafeInteger(expirationLedger) || expirationLedger < 1 || expirationLedger > 0xffffffff) throw new Error("Invalid Stellar allowance expiration.");
  const args = [new Address(t.sender).toScVal(), nativeToScVal(a.amount * BigInt(10), { type: "i128" }),
    nativeToScVal(t.destinationDomain, { type: "u32" }), bytes(a.mintRecipient), new Address(usdc).toScVal(), bytes(a.destinationCaller),
    nativeToScVal(a.maxFee * BigInt(10), { type: "i128" }), nativeToScVal(t.finality, { type: "u32" })];
  return {
    // Soroban allows one invoke operation per transaction: confirm this exact
    // allowance before building/simulating the burn, and refresh the fee again.
    approve: new Contract(usdc).call("approve", new Address(t.sender).toScVal(), new Address(CCTP_STELLAR.messenger).toScVal(),
      nativeToScVal(a.amount * BigInt(10), { type: "i128" }), nativeToScVal(expirationLedger, { type: "u32" })),
    burn: new Contract(CCTP_STELLAR.messenger).call(a.hook === "0x" ? "deposit_for_burn" : "deposit_for_burn_with_hook", ...args, ...(a.hook === "0x" ? [] : [bytes(a.hook)])),
  };
}
export function cctpStellarClaimOperation(recipient: string, message: Hex, attestation: Hex) {
  const proof = assertCctpNativeDestination(27, recipient, message, attestation);
  return new Contract(CCTP_STELLAR.forwarder).call("mint_and_forward", xdr.ScVal.scvBytes(proof.message), xdr.ScVal.scvBytes(proof.attestation));
}
