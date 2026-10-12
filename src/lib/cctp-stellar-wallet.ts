import { Address, Networks, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { CCTP_STELLAR } from "./cctp-native";
import { CCTP_STELLAR_USDC } from "./cctp-stellar";
import { CCTP_STELLAR_RPC } from "./cctp-stellar-monitor";
import type { QuoteUserStep } from "./bridge-types";

type Wallet = Pick<typeof import("@stellar/freighter-api"), "getAddress" | "getNetworkDetails" | "signTransaction">;
type Lifecycle = { beforeSign?: () => void; submitted?: (hash: string) => void };

export async function submitCctpStellarTransaction(encoded: string, expectedAccount: string, lifecycle: Lifecycle, deps: {
  wallet: Wallet; server: Pick<rpc.Server, "getNetwork" | "sendTransaction">;
}) {
  const tx = TransactionBuilder.fromXDR(encoded, Networks.PUBLIC);
  if (!(tx instanceof Transaction) || tx.source !== expectedAccount || tx.operations.length !== 1) throw new Error("Stellar CCTP transaction does not match the connected account.");
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract" || op.source && op.source !== expectedAccount) throw new Error("Unsupported Stellar CCTP operation.");
  const call = op.func.invokeContract, contract = Address.fromScAddress(call.contractAddress).toString(), name = call.functionName.toString();
  if (!(contract === CCTP_STELLAR_USDC && name === "approve" || contract === CCTP_STELLAR.messenger && ["deposit_for_burn", "deposit_for_burn_with_hook"].includes(name) ||
      contract === CCTP_STELLAR.forwarder && name === "mint_and_forward")) throw new Error("Unexpected Stellar CCTP contract or method.");
  const assertWallet = async () => {
    const [account, walletNetwork, network] = await Promise.all([deps.wallet.getAddress(), deps.wallet.getNetworkDetails(), deps.server.getNetwork()]);
    if (account.error || account.address !== expectedAccount || walletNetwork.error || walletNetwork.networkPassphrase !== Networks.PUBLIC || network.passphrase !== Networks.PUBLIC) throw new Error("Stellar wallet account or mainnet network changed.");
  };
  await assertWallet(); lifecycle.beforeSign?.();
  const signed = await deps.wallet.signTransaction(encoded, { networkPassphrase: Networks.PUBLIC, address: expectedAccount });
  if (signed.error || !signed.signedTxXdr || signed.signerAddress !== expectedAccount) throw new Error(signed.error?.message ?? "Freighter did not return the expected signer.");
  const transaction = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.PUBLIC);
  const hash = Buffer.from(tx.hash()).toString("hex");
  if (!(transaction instanceof Transaction) || Buffer.from(transaction.hash()).toString("hex") !== hash || !transaction.signatures.length) throw new Error("The Stellar wallet changed the reviewed CCTP transaction.");
  await assertWallet(); lifecycle.beforeSign?.();
  // Unlike wallet-managed sends, the signed envelope gives us its final hash
  // before broadcasting. Recovery must be durable before the network request.
  lifecycle.submitted?.(hash);
  const result = await deps.server.sendTransaction(transaction);
  if (result.hash.toLowerCase() !== hash) throw new Error("Stellar broadcast hash mismatch; check wallet activity before retrying.");
  if (result.status !== "PENDING" && result.status !== "DUPLICATE") throw new Error("Stellar did not accept this CCTP transaction. Check its status before retrying.");
  return hash;
}

export async function executeStellarCctpSteps(steps: QuoteUserStep[], account: string, lifecycle: Lifecycle = {}) {
  if (steps.length !== 1) throw new Error("Submit and confirm each Stellar CCTP operation separately.");
  const step = steps[0];
  if (step.type !== "TRANSACTION" || step.chainType !== "STELLAR") throw new Error("Invalid Stellar CCTP step.");
  const encoded = (step as import("./bridge-types").TransactionUserStep).transaction.encoded;
  if (encoded.cctp !== true || typeof encoded.serializedTransaction !== "string") throw new Error("Invalid Stellar CCTP transaction.");
  return submitCctpStellarTransaction(encoded.serializedTransaction, account, lifecycle, {
    wallet: await import("@stellar/freighter-api"), server: new rpc.Server(CCTP_STELLAR_RPC),
  });
}
