import { isCcipTransactionHash } from "./ccip-addresses";
import type { SolanaSubmission } from "./solana-confirmation";

export type ExecutionHistoryItem = {
  id: string;
  quoteId: string;
  executionKey?: string;
  ccipTransferKey?: string;
  solanaSubmission?: SolanaSubmission;
  ccipSubmission?: { chainId: number; family?: string; hash: string; confirmed: boolean };
  phase: "running" | "pending" | "success" | "error";
  createdAt: number;
  updatedAt: number;
  routeLabel: string;
  srcChainName: string;
  dstChainName: string;
  srcChainIconUrl?: string;
  dstChainIconUrl?: string;
  srcTokenSymbol: string;
  dstTokenSymbol: string;
  srcTokenIconUrl?: string;
  dstTokenIconUrl?: string;
  srcAmount: string;
  expectedDstAmount: string;
  minimumDstAmount?: string | null;
  destinationAddress: string;
  currentStep?: string;
  transferStatus?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
};

export const EXECUTION_HISTORY_KEY = "earthbound:execution-history:v1";
const HISTORY_LIMIT = 30;

export function parseExecutionHistory(serialized: string | null): ExecutionHistoryItem[] {
  try {
    const value: unknown = JSON.parse(serialized ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ExecutionHistoryItem => {
      if (!item || typeof item !== "object") return false;
      const strings = ["id", "quoteId", "routeLabel", "srcChainName", "dstChainName", "srcTokenSymbol", "dstTokenSymbol", "srcAmount", "expectedDstAmount", "destinationAddress"];
      if (!strings.every((key) => typeof item[key] === "string") || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) return false;
      if (!["running", "pending", "success", "error"].includes(item.phase)) return false;
      if (item.solanaSubmission && typeof item.solanaSubmission.signature !== "string") return false;
      if (item.ccipSubmission && (!Number.isSafeInteger(item.ccipSubmission.chainId) || !isCcipTransactionHash(item.ccipSubmission.family ?? "EVM", item.ccipSubmission.hash) || typeof item.ccipSubmission.confirmed !== "boolean")) return false;
      return true;
    });
  } catch { return []; }
}

export function mergeExecutionHistory(...groups: ExecutionHistoryItem[][]): ExecutionHistoryItem[] {
  const byId = new Map<string, ExecutionHistoryItem>();
  for (const group of groups) for (const item of group) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, HISTORY_LIMIT);
}

// Remove the tab-only copy only after its durable replacement has been written.
export function loadExecutionHistory(storage: Storage, legacyStorage: Storage): ExecutionHistoryItem[] {
  const saved = parseExecutionHistory(storage.getItem(EXECUTION_HISTORY_KEY));
  let legacy: ExecutionHistoryItem[] = [];
  try { legacy = parseExecutionHistory(legacyStorage.getItem(EXECUTION_HISTORY_KEY)); } catch { /* Durable history remains readable without session storage. */ }
  const merged = mergeExecutionHistory(saved, legacy);
  if (legacy.length) {
    storage.setItem(EXECUTION_HISTORY_KEY, JSON.stringify(merged));
    try { legacyStorage.removeItem(EXECUTION_HISTORY_KEY); } catch { /* Migration is already durable. */ }
  }
  return merged;
}

export function recoverExecutionHistory(items: ExecutionHistoryItem[]): ExecutionHistoryItem[] {
  return items.map((item) => item.phase === "running" ? {
    ...item,
    phase: item.solanaSubmission || item.ccipSubmission ? "pending" : "error",
    transferStatus: item.ccipSubmission?.confirmed ? "PENDING" : item.solanaSubmission || item.ccipSubmission ? "CONFIRMATION_PENDING" : undefined,
    currentStep: undefined,
    error: item.solanaSubmission || item.ccipSubmission ? "Check the submitted transaction before sending again." : "Execution was interrupted. Check your wallet activity before retrying.",
  } : item);
}
