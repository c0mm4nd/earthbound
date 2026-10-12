import { formatUnits, keccak256, stringToHex } from "viem";
import { cctpApi } from "./cctp-api";
import { CctpRequestError, cctpUnits, isCctpUsdc } from "./cctp";
import { CCTP_EVM } from "./cctp-evm";
import { CCTP_CHAINS, cctpForKey } from "./cctp-catalog";
import { validateCctpNativeIntent } from "./cctp-native-record";
import { normalizeCctpRecipient } from "./cctp-recipients";
import { viemChainById } from "./viem-chains-by-id";
import type { BridgeChain, BridgeQuote, BridgeQuoteResponse, BridgeToken } from "./bridge-types";

export function cctpBridgeChains(): BridgeChain[] {
  const evm: BridgeChain[] = CCTP_EVM.flatMap(c => {
    const chain = viemChainById[c.chainId];
    if (!chain || chain.testnet) return [];
    return [{ name: c.name, shortName: c.name, chainKey: c.chainKey, chainId: c.chainId, chainType: "EVM", nativeCurrency: {
      chainKey: c.chainKey, address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", ...chain.nativeCurrency,
    } }];
  });
  const currencies: Record<string, [string, number]> = { SOLANA: ["SOL", 9], APTOS: ["APT", 8], SUI: ["SUI", 9], STARKNET: ["STRK", 18], STELLAR: ["XLM", 7] };
  return [...evm, ...CCTP_CHAINS.filter(c => c.family !== "EVM").map(c => ({
    name: c.name, shortName: c.name, chainKey: c.chainKey, chainId: c.family === "APTOS" ? 1 : 0, chainType: c.family,
    nativeCurrency: { chainKey: c.chainKey, address: "native", name: currencies[c.family][0], symbol: currencies[c.family][0], decimals: currencies[c.family][1] },
  }))];
}
export function mergeCctpTokens(tokens: BridgeToken[], fromChain?: string | null, fromToken?: string | null): BridgeToken[] {
  const source = fromChain && cctpForKey(fromChain);
  const include = !fromChain || Boolean(source && isCctpUsdc(source, fromToken));
  const result = new Map(tokens.map(t => [`${t.chainKey}:${t.address.startsWith("0x") ? t.address.toLowerCase() : t.address}`, t]));
  if (include) for (const c of CCTP_CHAINS) {
    if (source && c.domain === source.domain) continue;
    const key = `${c.chainKey}:${c.usdc.startsWith("0x") ? c.usdc.toLowerCase() : c.usdc}`, existing = result.get(key);
    result.set(key, { ...existing, chainKey: c.chainKey, address: c.usdc, symbol: "USDC", name: "USDC", decimals: c.decimals,
      isSupported: true, isBridgeable: true, isVerified: true,
      bridgeProviders: [...new Set([...(existing?.bridgeProviders ?? []), "cctp" as const])],
    });
  }
  return [...result.values()];
}

export async function getCctpBridgeQuotes(body: unknown): Promise<BridgeQuoteResponse> {
  if (!body || typeof body !== "object") throw new CctpRequestError("Invalid CCTP quote request.");
  const r = body as Record<string, unknown>;
  const source = typeof r.srcChainKey === "string" && cctpForKey(r.srcChainKey);
  const destination = typeof r.dstChainKey === "string" && cctpForKey(r.dstChainKey);
  if (!source || !destination || source.domain === destination.domain || !isCctpUsdc(source, r.srcTokenAddress) || !isCctpUsdc(destination, r.dstTokenAddress) ||
      typeof r.amount !== "string" || !/^[1-9]\d{0,77}$/.test(r.amount)) throw new CctpRequestError("Choose native USDC and valid wallets on two supported CCTP networks.");
  const sender = normalizeCctpRecipient(source.family, r.srcWalletAddress), recipient = normalizeCctpRecipient(destination.family, r.dstWalletAddress);
  const scale = BigInt(10) ** BigInt(source.decimals - 6), amount = BigInt(r.amount) / scale;
  if (BigInt(r.amount) % scale !== BigInt(0)) throw new CctpRequestError("CCTP transfers support six decimal places. Leave the seventh Stellar decimal in your wallet.");
  const native = source.family !== "EVM" || destination.family !== "EVM";
  const result = await cctpApi.estimate({ sourceDomain: source.domain, destinationDomain: destination.domain,
    sourceToken: source.usdc, destinationToken: destination.usdc, amount: formatUnits(BigInt(r.amount), source.decimals) });
  let allowance: bigint | undefined;
  if (result.quotes.some(q => q.mode === "fast")) {
    try {
      const response = await fetch("https://iris-api.circle.com/v2/fastBurn/USDC/allowance", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (response.ok) allowance = cctpUnits(String((await response.json()).allowance), 6);
    } catch { /* Standard quotes remain available if Fast capacity is unknown. */ }
  }
  const quotes: BridgeQuote[] = result.quotes.flatMap(q => {
    if (q.mode === "fast" && (allowance === undefined || allowance < amount)) return [];
    const intent = { sourceDomain: source.domain, destinationDomain: destination.domain, sender, recipient, amount: amount.toString(), maxFee: q.protocolFee, finality: q.finalityThreshold };
    validateCctpNativeIntent(intent);
    return [{
      id: `cctp-${keccak256(stringToHex(JSON.stringify([source.domain, destination.domain, r.amount, r.srcWalletAddress, r.dstWalletAddress, q.mode, q.quotedAt]))).slice(2)}`,
      provider: "cctp", srcAmount: r.amount as string, dstAmount: q.destinationAmount, dstAmountMin: q.destinationAmount,
      ...(native ? { cctpNative: { ...intent, quotedAt: q.quotedAt } } : { cctp: { ...intent, quotedAt: q.quotedAt } }),
      routeSteps: [{ type: q.mode === "fast" ? "CCTP_FAST" : "CCTP_STANDARD", srcChainKey: source.chainKey, dstChainKey: destination.chainKey }],
      userSteps: [], fees: [{ type: "protocol", amount: q.protocolFee, tokenAddress: source.usdc, chainKey: source.chainKey, decimals: 6, symbol: "USDC", description: "Circle protocol fee; network gas is paid separately on both chains." }],
    }];
  });
  return { quotes, rejectedQuotes: result.rejectedQuotes };
}
