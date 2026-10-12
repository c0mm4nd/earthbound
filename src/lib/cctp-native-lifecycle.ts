import { type Hex } from "viem";
import { isCctpNativeHash, assertCctpNativeTransfer, type CctpNativeTransfer } from "./cctp-native-record";
export { assertCctpNativeTransfer, type CctpNativeTransfer } from "./cctp-native-record";
import { assertCctpNativeMessage, verifyCctpNativeProof, type CctpNativeProof } from "./cctp-native-proof";

type ReceiptState = "pending" | "failed" | "confirmed";
export interface CctpNativeMonitor {
  // Adapters must check the RPC's mainnet identity, the queried hash, receipt
  // success and Circle's emitter before returning a source message.
  sourceReceipt(t: CctpNativeTransfer): Promise<{ state: ReceiptState; message?: Hex }>;
  circleProof(t: CctpNativeTransfer): Promise<CctpNativeProof | null>;
  destinationAttesters(): Promise<{ domain: number; threshold: number; enabledAttesters: string[] }>;
  nonceUsed(nonce: Hex): Promise<boolean>;
  claimReceipt(hash: string): Promise<ReceiptState>;
}
const rejected = (error: unknown) => Boolean(error && typeof error === "object" && ("code" in error && error.code === 4001 || "name" in error && error.name === "UserRejectedRequestError"));

export async function monitorNativeCctp(t: CctpNativeTransfer, deps: CctpNativeMonitor): Promise<{ transfer: CctpNativeTransfer; proof?: CctpNativeProof }> {
  assertCctpNativeTransfer(t);
  if (!t.burnHash) throw new Error("Recover the burn hash from wallet activity first.");
  const source = await deps.sourceReceipt(t);
  if (source.state === "failed") return { transfer: { ...t, state: "failed" } };
  if (source.state === "pending") return { transfer: { ...t, state: t.state === "claim_pending" ? "claim_pending" : "burn_pending" } };
  if (!source.message) throw new Error("Confirmed source transaction has no Circle message.");
  assertCctpNativeMessage(t, source.message, false);
  t = { ...t, sourceMessage: source.message };
  const proof = await deps.circleProof(t);
  if (!proof) return { transfer: { ...t, state: t.state === "claim_pending" ? "claim_pending" : "attestation_pending" } };
  const { nonce } = await verifyCctpNativeProof(t, source.message, proof, await deps.destinationAttesters());
  if (await deps.nonceUsed(nonce)) return { transfer: { ...t, state: "complete" } };
  if (t.state === "claim_pending" && !t.claimHash) return { transfer: t };
  if (t.claimHash) {
    if (await deps.claimReceipt(t.claimHash) !== "failed") return { transfer: { ...t, state: "claim_pending" } };
    t = { ...t, claimHash: undefined };
  }
  return { transfer: { ...t, state: "ready" }, proof };
}

type Submission = (submitted: (hash: string) => void) => Promise<string | undefined>;
type Persistence = { persist(t: CctpNativeTransfer): void; assertContext(): void };
export async function submitNative(t: CctpNativeTransfer, operation: "burn" | "claim", send: Submission, deps: Persistence) {
  const domain = operation === "burn" ? t.sourceDomain : t.destinationDomain;
  let savedHash: string | undefined;
  const submitted = (hash: string) => {
    if (!isCctpNativeHash(domain, hash)) throw new Error("Wallet returned no valid CCTP hash. Check wallet activity before retrying.");
    if (savedHash && savedHash !== hash) throw new Error("Multiple CCTP submission hashes require manual recovery.");
    savedHash = hash;
    t = { ...t, ...(operation === "burn" ? { burnHash: hash } : { claimHash: hash }) }; deps.persist(t);
  };
  deps.assertContext();
  t = { ...t, state: operation === "burn" ? "burn_pending" : "claim_pending" };
  deps.persist(t); // Durable storage must succeed before any wallet request.
  try {
    const hash = await send(submitted);
    if (!savedHash && hash) submitted(hash);
    if (!savedHash) throw new Error("Wallet response is uncertain. Recover the transaction hash before retrying.");
  } catch (error) {
    if (!savedHash && rejected(error)) deps.persist({ ...t, state: operation === "burn" ? "failed" : "ready" });
    throw error;
  }
  return t;
}
export async function initiateNativeCctp(t: CctpNativeTransfer, deps: Persistence & {
  // Includes deployment/limit checks, wallet simulation and any prerequisite
  // approval. Returned send executes exactly one burn and reports its hash
  // before awaiting confirmation. It must never report an approval's hash.
  prepareBurn(): Promise<Submission>; refreshFee(): Promise<bigint>;
}) {
  assertCctpNativeTransfer(t);
  if (t.state !== "preparing" || t.burnHash) throw new Error("This CCTP burn needs recovery before retrying.");
  deps.assertContext();
  if (await deps.refreshFee() > BigInt(t.maxFee)) throw new Error("CCTP fees changed. Request a new quote.");
  const send = await deps.prepareBurn();
  if (await deps.refreshFee() > BigInt(t.maxFee)) throw new Error("CCTP fees changed after preparation. Request a new quote.");
  return submitNative(t, "burn", send, deps);
}
export async function claimNativeCctp(t: CctpNativeTransfer, deps: Persistence & CctpNativeMonitor & {
  // Build and simulate the appropriate chain's receive. Confirm Solana ATA
  // preparation first; Stellar calls the official forwarder atomically.
  prepareClaim(proof: CctpNativeProof): Promise<Submission>;
}) {
  const result = await monitorNativeCctp(t, deps); deps.persist(result.transfer);
  if (result.transfer.state === "complete") return result.transfer;
  if (result.transfer.state !== "ready" || !result.proof) throw new Error("This CCTP claim is not ready or needs recovery.");
  deps.assertContext();
  const send = await deps.prepareClaim(result.proof);
  return submitNative(result.transfer, "claim", send, deps);
}
