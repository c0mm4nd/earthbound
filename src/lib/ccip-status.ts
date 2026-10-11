import { ccipAddressKey, isCcipTransactionHash } from "./ccip-addresses";
import type { BridgeStatusResponse } from "./bridge-types";

export function ccipStatusQuery(quoteId: string, txHash: string | null) {
  const match = /^ccip:(\d{1,20}):(\d{1,20}):\d{1,16}$/.exec(quoteId);
  if (!match || match[1] === match[2] || [match[1], match[2]].some(s => BigInt(s) === BigInt(0) || BigInt(s) >= BigInt(2) ** BigInt(64)) ||
      !txHash || !isCcipTransactionHash(match[1] === "124615329519749607" ? "SOLANA" : match[1] === "4741433654826277614" ? "APTOS" : match[1] === "2308837218439511688" ? "CANTON" : "EVM", txHash)) throw new Error("A CCIP route and source transaction hash are required.");
  return new URLSearchParams({ sourceChainSelector: match[1], destChainSelector: match[2], sourceTransactionHash: txHash, limit: "10" });
}

export function normalizeCcipStatus(data: unknown, query: URLSearchParams): BridgeStatusResponse {
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) throw new Error("Invalid CCIP tracking response.");
  const messages = data.data.filter(message => message && typeof message === "object" &&
    typeof message.sendTransactionHash === "string" && (query.get("sourceChainSelector") === "124615329519749607"
      ? message.sendTransactionHash === query.get("sourceTransactionHash")
      : ccipAddressKey(message.sendTransactionHash) === ccipAddressKey(query.get("sourceTransactionHash")!)) &&
    String(message.sourceNetworkInfo?.chainSelector) === query.get("sourceChainSelector") &&
    String(message.destNetworkInfo?.chainSelector) === query.get("destChainSelector"));
  if (!messages.length) return { status: "PENDING", substatus: "Waiting for CCIP to index the source transaction." };
  if (messages.length !== 1) throw new Error("Multiple CCIP messages found. Inspect the source transaction before retrying.");
  const message = messages[0];
  if (typeof message.messageId !== "string" || !/^0x[0-9a-f]{64}$/i.test(message.messageId)) throw new Error("Invalid CCIP message ID.");
  const explorerUrl = `https://ccip.chain.link/msg/${message.messageId}`;
  if (message.status === "SUCCESS") return { status: "COMPLETED", explorerUrl };
  // Execution failures can be retried on the destination; never invite a duplicate send.
  if (message.readyForManualExecution || message.status === "FAILED") return { status: "ACTION_REQUIRED", explorerUrl, substatus: "Destination execution needs attention. Open the CCIP message for recovery details; do not resend." };
  return { status: "PENDING", explorerUrl, substatus: "CCIP is processing the transfer." };
}

export async function getCcipStatus(quoteId: string, txHash: string | null) {
  const query = ccipStatusQuery(quoteId, txHash);
  const response = await fetch(`https://api.ccip.chain.link/v2/messages?${query}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("CCIP tracking is temporarily unavailable. Your submitted transfer is still recorded.");
  return normalizeCcipStatus(await response.json(), query);
}
