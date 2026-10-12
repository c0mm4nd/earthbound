import type { BridgeQuote, TransactionUserStep } from "./bridge-types";
import type { CcipQuoteRequest } from "./ccip";
import { cctpNetwork, isCctpUsdc } from "./cctp";
import { cctpForKey, cctpAccountEqual } from "./cctp-catalog";
import { assertCctpNativeTransfer, submitNative, type CctpNativeTransfer } from "./cctp-native-lifecycle";
import type { CctpNativePlan } from "./cctp-native-service";

export function assertNativeCctpQuote(quote: BridgeQuote, request: CcipQuoteRequest): CctpNativeTransfer {
  if (quote.provider !== "cctp" || !quote.cctpNative) throw new Error("Missing native CCTP quote.");
  const t: CctpNativeTransfer = { ...quote.cctpNative, state: "preparing" };
  assertCctpNativeTransfer(t);
  const source = cctpForKey(request.srcChainKey), destination = cctpForKey(request.dstChainKey);
  const amount = BigInt(t.amount) * BigInt(10) ** BigInt(cctpNetwork(t.sourceDomain).decimals - 6);
  const received = (BigInt(t.amount) - BigInt(t.maxFee)) * BigInt(10) ** BigInt(cctpNetwork(t.destinationDomain).decimals - 6);
  if (!source || !destination || source.domain !== t.sourceDomain || destination.domain !== t.destinationDomain ||
      !isCctpUsdc(source, request.srcTokenAddress) || !isCctpUsdc(destination, request.dstTokenAddress) ||
      !request.srcWalletAddress || !cctpAccountEqual(t.sender, request.srcWalletAddress) || !cctpAccountEqual(t.recipient, request.dstWalletAddress) ||
      amount.toString() !== request.amount || quote.srcAmount !== request.amount || quote.dstAmountMin !== received.toString() || quote.dstAmount !== received.toString() ||
      !Number.isFinite(quote.cctpNative.quotedAt) || Date.now() - quote.cctpNative.quotedAt > 60_000 || quote.cctpNative.quotedAt > Date.now() + 5000 ||
      quote.routeSteps.length !== 1 || quote.routeSteps[0].srcChainKey !== source.chainKey || quote.routeSteps[0].dstChainKey !== destination.chainKey) throw new Error("CCTP quote changed. Request a new quote.");
  return t;
}
export async function requestNativeCctp<T>(transfer: CctpNativeTransfer, action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api/bridge/cctp/native", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transfer, action, ...extra }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "CCTP service unavailable.");
  return result;
}
export type NativeCctpExecution = {
  assertContext(): void; persist(t: CctpNativeTransfer): void;
  send(step: TransactionUserStep, submitted: (hash: string) => void): Promise<string | undefined>;
  request?: typeof requestNativeCctp;
  pause?: () => Promise<void>;
};
export async function executeNativeCctp(t: CctpNativeTransfer, operation: "burn" | "claim", payer: string, deps: NativeCctpExecution) {
  assertCctpNativeTransfer(t);
  if (operation === "burn" && (t.state !== "preparing" || t.burnHash)) throw new Error("Recover this CCTP burn before retrying.");
  const request = deps.request ?? requestNativeCctp;
  let action = operation === "burn" ? "prepare" : "claim";
  for (let i = 0; i < 4; i++) {
    deps.assertContext();
    const plan = await request<CctpNativePlan>(t, action, { payer });
    assertCctpNativeTransfer(plan.transfer);
    // A plan may add only recovery state/event information, not alter the intent.
    for (const key of ["sourceDomain", "destinationDomain", "sender", "recipient", "amount", "maxFee", "finality"] as const) {
      if (plan.transfer[key] !== t[key]) throw new Error("CCTP transaction plan changed the reviewed transfer.");
    }
    t = plan.transfer; deps.persist(t);
    if (t.state === "complete") return t;
    const domain = operation === "burn" ? t.sourceDomain : t.destinationDomain;
    if (!plan.step || plan.step.chainType !== cctpNetwork(domain).family || plan.step.chainKey !== cctpForKey(plan.step.chainKey)?.chainKey || cctpForKey(plan.step.chainKey)?.domain !== domain) throw new Error("CCTP plan network mismatch.");
    const step = plan.step;
    if (!plan.prerequisite) {
      return submitNative(t, operation, submitted => deps.send(step, submitted), deps);
    }
    deps.assertContext();
    const hash = await deps.send(step, () => {});
    if (!hash) throw new Error("Preparation response is uncertain. Check wallet activity before continuing.");
    let confirmed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const receipt = await request<{ state: string }>(t, "receipt", { domain, hash });
      if (receipt.state === "failed") throw new Error("CCTP preparation transaction failed.");
      if (receipt.state === "confirmed") { confirmed = true; break; }
      await (deps.pause?.() ?? new Promise(resolve => setTimeout(resolve, 2000)));
    }
    if (!confirmed) throw new Error("Preparation confirmation is pending. Check wallet activity before continuing.");
    // Stellar approval and burn are separate Soroban transactions. EVM may need
    // allowance reset then approval; Solana may need its recipient ATA first.
    if (domain === 27 && operation === "burn") action = "burn";
  }
  throw new Error("CCTP preparation needs another status check.");
}
