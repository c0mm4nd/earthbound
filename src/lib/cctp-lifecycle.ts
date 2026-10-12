import { encodeFunctionData, erc20Abi, pad, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { assertCctpTransfer, CCTP_ABI, cctpApproveTransaction, cctpBurnTransaction, cctpEvm, cctpSourceMessage, type CctpTransfer } from "./cctp-evm";
import { assertCctpMessage, cctpAttesters, selectCctpAttestation } from "./cctp-message";

export type CctpClient = Pick<PublicClient, "getChainId" | "readContract" | "getTransactionReceipt" | "getBlockNumber" | "call">;
export type CctpProof = { message: Hex; attestation: Hex };

export async function verifyCctpDeployment(client: CctpClient, domain: number, remoteDomain: number) {
  const c = cctpEvm(domain), remote = cctpEvm(remoteDomain);
  const [chainId, localDomain, transmitter, remoteMessenger, paused] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "localDomain" }),
    client.readContract({ address: c.messenger, abi: CCTP_ABI, functionName: "localMessageTransmitter" }),
    client.readContract({ address: c.messenger, abi: CCTP_ABI, functionName: "remoteTokenMessengers", args: [remoteDomain] }),
    client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "paused" }),
  ]);
  if (chainId !== c.chainId || localDomain !== domain || transmitter.toLowerCase() !== c.transmitter || remoteMessenger.toLowerCase() !== pad(remote.messenger) || paused) {
    throw new Error("CCTP deployment or remote route is unavailable on this network.");
  }
}

export async function verifyCctpProof(client: CctpClient, t: CctpTransfer, proof: CctpProof) {
  const message = assertCctpMessage(proof.message, t, true);
  const destination = cctpEvm(t.destinationDomain);
  const signers = await cctpAttesters(proof.message, proof.attestation);
  const [threshold, enabled] = await Promise.all([
    client.readContract({ address: destination.transmitter, abi: CCTP_ABI, functionName: "signatureThreshold" }),
    Promise.all(signers.map(attester => client.readContract({ address: destination.transmitter, abi: CCTP_ABI, functionName: "isEnabledAttester", args: [attester as Address] }))),
  ]);
  if (threshold <= BigInt(0) || BigInt(signers.length) !== threshold || enabled.some(value => !value)) throw new Error("Circle attestation has not passed destination attester verification.");
  return message;
}

function missingReceipt(error: unknown) {
  return error instanceof Error && /TransactionReceiptNotFoundError|could not be found|not found/i.test(`${error.name} ${error.message}`);
}

export async function monitorCctpTransfer(t: CctpTransfer, deps: {
  source: CctpClient; destination: CctpClient;
  messages: (verified: CctpTransfer) => Promise<unknown>;
}): Promise<{ transfer: CctpTransfer; proof?: CctpProof }> {
  assertCctpTransfer(t);
  const ambiguousClaim = t.state === "claim_pending" && !t.claimHash;
  if (!t.burnHash) throw new Error("Check wallet activity for the burn transaction before retrying.");
  if (await deps.source.getChainId() !== cctpEvm(t.sourceDomain).chainId) throw new Error("Wrong source RPC network.");
  let receipt: TransactionReceipt;
  try { receipt = await deps.source.getTransactionReceipt({ hash: t.burnHash as Hex }); }
  catch (error) { if (missingReceipt(error)) return { transfer: { ...t, state: t.state === "claim_pending" ? "claim_pending" : "burn_pending" } }; throw error; }
  if (receipt.transactionHash.toLowerCase() !== t.burnHash.toLowerCase()) throw new Error("Source receipt hash mismatch.");
  if (receipt.status !== "success") return { transfer: { ...t, state: "failed" } };
  const sourceMessage = cctpSourceMessage(receipt, t);
  assertCctpMessage(sourceMessage, t, false);
  t = { ...t, sourceMessage, state: t.state === "claim_pending" ? "claim_pending" : "attestation_pending" };
  const proof = selectCctpAttestation(await deps.messages(t), t);
  if (!proof) return { transfer: t };
  await verifyCctpDeployment(deps.destination, t.destinationDomain, t.sourceDomain);
  const message = await verifyCctpProof(deps.destination, t, proof);
  const destination = cctpEvm(t.destinationDomain);
  const used = await deps.destination.readContract({ address: destination.transmitter, abi: CCTP_ABI, functionName: "usedNonces", args: [message.nonce] });
  // Iris 'complete' only means attested. Only the destination's consumed nonce,
  // after signature and source-receipt binding, proves successful minting.
  if (used !== BigInt(0)) return { transfer: { ...t, state: "complete" } };
  if (ambiguousClaim) return { transfer: { ...t, state: "claim_pending" } };
  if (t.claimHash) {
    try {
      const claim = await deps.destination.getTransactionReceipt({ hash: t.claimHash as Hex });
      if (claim.transactionHash.toLowerCase() !== t.claimHash.toLowerCase()) throw new Error("Claim receipt hash mismatch.");
      if (claim.status === "reverted") t = { ...t, claimHash: undefined };
      else return { transfer: { ...t, state: "claim_pending" } };
    } catch (error) {
      if (missingReceipt(error)) return { transfer: { ...t, state: "claim_pending" } };
      throw error;
    }
  }
  return { transfer: { ...t, state: "ready" }, proof };
}

type BurnDependencies = {
  source: CctpClient; destination: CctpClient; assertContext: () => void;
  refreshFee: () => Promise<bigint>;
  send: (tx: ReturnType<typeof cctpBurnTransaction>, kind: "approval" | "burn") => Promise<string>;
  wait: (hash: string, kind: "approval" | "burn") => Promise<TransactionReceipt>;
  persist: (transfer: CctpTransfer) => void;
  step: (message: string) => void;
};
export async function initiateCctpTransfer(t: CctpTransfer, deps: BurnDependencies) {
  assertCctpTransfer(t);
  if (t.burnHash || t.state !== "preparing") throw new Error("This burn has already been submitted or needs recovery.");
  const source = cctpEvm(t.sourceDomain), amount = BigInt(t.amount);
  deps.assertContext();
  await Promise.all([verifyCctpDeployment(deps.source, t.sourceDomain, t.destinationDomain), verifyCctpDeployment(deps.destination, t.destinationDomain, t.sourceDomain)]);
  const minter = await deps.source.readContract({ address: source.messenger, abi: CCTP_ABI, functionName: "localMinter" });
  const [limit, paused, balance, allowance] = await Promise.all([
    deps.source.readContract({ address: minter, abi: CCTP_ABI, functionName: "burnLimitsPerMessage", args: [source.usdc as Address] }),
    deps.source.readContract({ address: minter, abi: CCTP_ABI, functionName: "paused" }),
    deps.source.readContract({ address: source.usdc as Address, abi: erc20Abi, functionName: "balanceOf", args: [t.sender as Address] }),
    deps.source.readContract({ address: source.usdc as Address, abi: erc20Abi, functionName: "allowance", args: [t.sender as Address, source.messenger] }),
  ]);
  if (paused || limit < amount) throw new Error("CCTP burning is paused or the per-transfer limit is exceeded.");
  if (balance < amount) throw new Error("Insufficient native USDC balance.");
  const checkFee = async () => {
    const fee = await deps.refreshFee(); deps.assertContext();
    if (fee > BigInt(t.maxFee)) throw new Error("CCTP fee increased. Review a new quote before burning USDC.");
  };
  await checkFee();
  if (allowance < amount) for (const value of allowance > BigInt(0) ? [BigInt(0), amount] : [amount]) {
    deps.assertContext(); deps.step("Approving USDC for Circle CCTP");
    const hash = await deps.send(cctpApproveTransaction(t, value), "approval");
    const receipt = await deps.wait(hash, "approval");
    if (receipt.status !== "success") throw new Error("USDC approval reverted.");
  }
  await checkFee();
  deps.assertContext(); deps.step("Confirm the USDC burn in your wallet");
  // Save the intent before opening the wallet so an ambiguous wallet response
  // never causes an automatic second burn after a refresh.
  t = { ...t, state: "burn_pending" }; deps.persist(t);
  let hash: string;
  try { hash = await deps.send(cctpBurnTransaction(t), "burn"); }
  catch (error) {
    if (error && typeof error === "object" && ("code" in error && error.code === 4001 || "name" in error && error.name === "UserRejectedRequestError")) deps.persist({ ...t, state: "failed" });
    throw error;
  }
  if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Wallet did not return a valid burn hash. Check wallet activity before retrying.");
  t = { ...t, burnHash: hash }; deps.persist(t);
  const receipt = await deps.wait(hash, "burn");
  // A replacement receipt is recorded before parsing; recovery follows the mined hash.
  t = { ...t, burnHash: receipt.transactionHash }; deps.persist(t);
  if (receipt.status !== "success") { deps.persist({ ...t, state: "failed" }); throw new Error("CCTP burn reverted."); }
  const sourceMessage = cctpSourceMessage(receipt, t);
  assertCctpMessage(sourceMessage, t, false);
  t = { ...t, sourceMessage, state: "attestation_pending" }; deps.persist(t);
  return t;
}

export async function claimCctpTransfer(t: CctpTransfer, proof: CctpProof, deps: {
  destination: CctpClient; account: Address; assertContext: () => void;
  send: (tx: { to: Address; data: Hex; value: bigint }) => Promise<string>;
  persist: (transfer: CctpTransfer) => void;
}) {
  assertCctpTransfer(t);
  if (t.state !== "ready" || t.claimHash) throw new Error("Check the CCTP transfer status before claiming.");
  deps.assertContext();
  await verifyCctpDeployment(deps.destination, t.destinationDomain, t.sourceDomain);
  const message = await verifyCctpProof(deps.destination, t, proof);
  const destination = cctpEvm(t.destinationDomain);
  if (await deps.destination.readContract({ address: destination.transmitter, abi: CCTP_ABI, functionName: "usedNonces", args: [message.nonce] }) !== BigInt(0)) {
    deps.persist({ ...t, state: "complete" }); return;
  }
  const tx = { to: destination.transmitter, value: BigInt(0), data: encodeFunctionData({ abi: CCTP_ABI, functionName: "receiveMessage", args: [proof.message, proof.attestation] }) };
  // Includes signature, nonce, expiry and destination mint checks. Arbitrum-family
  // expiry is an L1 block number; do not compare it to the L2 RPC block number.
  await deps.destination.call({ ...tx, account: deps.account });
  deps.assertContext();
  t = { ...t, state: "claim_pending" }; deps.persist(t);
  let hash: string;
  try { hash = await deps.send(tx); }
  catch (error) {
    if (error && typeof error === "object" && ("code" in error && error.code === 4001 || "name" in error && error.name === "UserRejectedRequestError")) deps.persist({ ...t, state: "ready" });
    throw error;
  }
  if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Wallet did not return a valid claim hash. Check wallet activity before retrying.");
  deps.persist({ ...t, claimHash: hash });
}
