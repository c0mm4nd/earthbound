import { Networks, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { CCTP_STELLAR_RPC } from "./cctp-stellar-monitor";
import { cctpStellarBurnOperations, cctpStellarClaimOperation } from "./cctp-stellar";
import type { CctpNativeTransfer } from "./cctp-native-lifecycle";
import type { CctpNativeProof } from "./cctp-native-proof";

export async function prepareCctpStellarTransaction(t: CctpNativeTransfer, payer: string, action: "prepare" | "burn" | "claim", proof?: CctpNativeProof) {
  const server = new rpc.Server(CCTP_STELLAR_RPC);
  if ((await server.getNetwork()).passphrase !== Networks.PUBLIC) throw new Error("CCTP requires Stellar mainnet.");
  const [account, ledger] = await Promise.all([server.getAccount(payer), server.getLatestLedger()]);
  const operation = proof ? cctpStellarClaimOperation(t.recipient, proof.message, proof.attestation)
    : cctpStellarBurnOperations(t, ledger.sequence + 120)[action === "prepare" ? "approve" : "burn"];
  const tx = new TransactionBuilder(account, { networkPassphrase: Networks.PUBLIC, fee: "100" }).addOperation(operation).setTimeout(120).build();
  return (await server.prepareTransaction(tx)).toXDR();
}
