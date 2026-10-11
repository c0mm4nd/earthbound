import type { BridgeQuote, TransactionUserStep } from "./bridge-types";
import { isCcipAddress } from "./ccip-addresses";
import { ccipMessageEncoding } from "./ccip-message";

export const APTOS_MAINNET_API = "https://fullnode.mainnet.aptoslabs.com/v1";

export function ccipAptosPayload(quote: BridgeQuote, operation: "ccip_send" | "get_fee" = "ccip_send") {
  const c = quote.ccip;
  if (!c || c.sourceFamily !== "APTOS" || !isCcipAddress("APTOS", c.router) || !isCcipAddress("APTOS", c.sourceToken) ||
      !/^\d+$/.test(quote.srcAmount) || BigInt(quote.srcAmount) <= BigInt(0) || BigInt(quote.srcAmount) >= BigInt(2) ** BigInt(64)) {
    throw new Error("Invalid Aptos CCIP transfer.");
  }
  const { receiver, extraArgs } = ccipMessageEncoding("APTOS", c.destinationFamily ?? "EVM", c.receiver);
  return {
    type: "entry_function_payload",
    function: `${c.router}::router::${operation}`,
    type_arguments: [] as string[],
    arguments: [c.destinationSelector, receiver, "0x", [c.sourceToken], [quote.srcAmount], ["0x0"], "0xa", "0x0", extraArgs],
  };
}

export function ccipAptosStep(quote: BridgeQuote, chainKey: string): TransactionUserStep {
  return { type: "TRANSACTION", chainType: "APTOS", chainKey, description: "Send CCIP transfer",
    transaction: { encoded: { payload: ccipAptosPayload(quote), ccip: true } } };
}

export async function inspectAptosSubmission(hash: string, fetcher: typeof fetch = fetch): Promise<"confirmed" | "failed" | "pending"> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("Invalid Aptos transaction hash.");
  try {
    const response = await fetcher(`${APTOS_MAINNET_API}/transactions/by_hash/${hash}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return "pending";
    const tx = await response.json();
    if (typeof tx.hash !== "string" || tx.hash.toLowerCase() !== hash.toLowerCase()) return "pending";
    if (tx.type === "pending_transaction") return "pending";
    if (tx.type !== "user_transaction" || typeof tx.success !== "boolean") return "pending";
    return tx.success ? "confirmed" : "failed";
  } catch { return "pending"; }
}
