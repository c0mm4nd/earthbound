import type { Connection } from "@solana/web3.js";

export type SolanaValidity = { blockhash: string; lastValidBlockHeight: number };
export type SolanaSubmission = { signature: string; validity?: SolanaValidity };
export type SolanaOutcome = "confirmed" | "failed" | "expired" | "pending";

export class SolanaConfirmationError extends Error {
  readonly transactionHash: string;
  constructor(readonly outcome: Exclude<SolanaOutcome, "confirmed">, readonly submission: SolanaSubmission, detail?: string) {
    super(outcome === "failed" ? `Solana transaction failed on chain${detail ? `: ${detail}` : "."}`
      : outcome === "expired" ? "Solana transaction expired without confirmation. Refresh the quote before trying again."
      : "Solana transaction was submitted. Confirmation is still pending; check its status before sending again.");
    this.name = "SolanaConfirmationError";
    this.transactionHash = submission.signature;
  }
}

// HTTP polling also works on RPC services whose WebSocket subscriptions are unavailable.
// Expiration alone does not prove failure: check historical status after finalized height passes validity.
export async function inspectSolanaSubmission(connection: Connection, submission: SolanaSubmission): Promise<{ outcome: SolanaOutcome; detail?: string }> {
  const readStatus = async () => (await connection.getSignatureStatuses([submission.signature], { searchTransactionHistory: true })).value[0];
  const classify = (status: Awaited<ReturnType<typeof readStatus>>) => {
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" || status.confirmations === null)) {
      return status.err ? { outcome: "failed" as const, detail: JSON.stringify(status.err) } : { outcome: "confirmed" as const };
    }
    return null;
  };
  try {
    const status = await readStatus();
    const known = classify(status);
    if (known) return known;
    if (submission.validity && await connection.getBlockHeight("finalized") > submission.validity.lastValidBlockHeight) {
      const finalStatus = await readStatus();
      return classify(finalStatus) ?? { outcome: finalStatus ? "pending" : "expired" };
    }
  } catch {
    // An unavailable RPC is not evidence that a transaction failed or expired.
  }
  return { outcome: "pending" };
}

export async function confirmSolanaSubmission(connection: Connection, submission: SolanaSubmission, options: { timeoutMs?: number; pollIntervalMs?: number } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  do {
    const result = await inspectSolanaSubmission(connection, submission);
    if (result.outcome === "confirmed") return;
    if (result.outcome !== "pending") throw new SolanaConfirmationError(result.outcome, submission, result.detail);
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1_500));
  } while (Date.now() < deadline);
  throw new SolanaConfirmationError("pending", submission);
}
