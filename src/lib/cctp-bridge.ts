import { formatUnits, isAddress, keccak256, stringToHex, zeroAddress } from "viem";
import { cctpApi } from "./cctp-api";
import { CctpRequestError, cctpUnits, isCctpUsdc } from "./cctp";
import { CCTP_EVM, cctpEvmForKey } from "./cctp-evm";
import { viemChainById } from "./viem-chains-by-id";
import type { BridgeChain, BridgeQuote, BridgeQuoteResponse, BridgeToken } from "./bridge-types";

export function cctpBridgeChains(): BridgeChain[] {
  return CCTP_EVM.flatMap(c => {
    const chain = viemChainById[c.chainId];
    if (!chain || chain.testnet) return [];
    return [{ name: c.name, shortName: c.name, chainKey: c.chainKey, chainId: c.chainId, chainType: "EVM", nativeCurrency: {
      chainKey: c.chainKey, address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", ...chain.nativeCurrency,
    } }];
  });
}
export function mergeCctpTokens(tokens: BridgeToken[], fromChain?: string | null, fromToken?: string | null): BridgeToken[] {
  const source = fromChain && cctpEvmForKey(fromChain);
  const include = !fromChain || Boolean(source && isCctpUsdc(source, fromToken));
  const result = new Map(tokens.map(t => [`${t.chainKey}:${t.address.startsWith("0x") ? t.address.toLowerCase() : t.address}`, t]));
  if (include) for (const c of CCTP_EVM) {
    if (source && c.domain === source.domain) continue;
    const key = `${c.chainKey}:${c.usdc.toLowerCase()}`, existing = result.get(key);
    result.set(key, { ...existing, chainKey: c.chainKey, address: c.usdc, symbol: "USDC", name: "USDC", decimals: 6,
      isSupported: true, isBridgeable: true, isVerified: true,
      bridgeProviders: [...new Set([...(existing?.bridgeProviders ?? []), "cctp" as const])],
    });
  }
  return [...result.values()];
}

export async function getCctpBridgeQuotes(body: unknown): Promise<BridgeQuoteResponse> {
  if (!body || typeof body !== "object") throw new CctpRequestError("Invalid CCTP quote request.");
  const r = body as Record<string, unknown>;
  const source = typeof r.srcChainKey === "string" && cctpEvmForKey(r.srcChainKey);
  const destination = typeof r.dstChainKey === "string" && cctpEvmForKey(r.dstChainKey);
  if (!source || !destination || source.domain === destination.domain || !isCctpUsdc(source, r.srcTokenAddress) || !isCctpUsdc(destination, r.dstTokenAddress) ||
      ![r.srcWalletAddress, r.dstWalletAddress].every(a => typeof a === "string" && isAddress(a) && a.toLowerCase() !== zeroAddress) ||
      typeof r.amount !== "string" || !/^[1-9]\d{0,77}$/.test(r.amount)) throw new CctpRequestError("Choose native USDC and valid wallets on two supported CCTP networks.");
  const result = await cctpApi.estimate({ sourceDomain: source.domain, destinationDomain: destination.domain,
    sourceToken: source.usdc, destinationToken: destination.usdc, amount: formatUnits(BigInt(r.amount), 6) });
  let allowance: bigint | undefined;
  if (result.quotes.some(q => q.mode === "fast")) {
    try {
      const response = await fetch("https://iris-api.circle.com/v2/fastBurn/USDC/allowance", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (response.ok) allowance = cctpUnits(String((await response.json()).allowance), 6);
    } catch { /* Standard quotes remain available if Fast capacity is unknown. */ }
  }
  const quotes: BridgeQuote[] = result.quotes.flatMap(q => {
    if (q.mode === "fast" && (allowance === undefined || allowance < BigInt(r.amount as string))) return [];
    return [{
      id: `cctp-${keccak256(stringToHex(JSON.stringify([source.domain, destination.domain, r.amount, r.srcWalletAddress, r.dstWalletAddress, q.mode, q.quotedAt]))).slice(2)}`,
      provider: "cctp", srcAmount: r.amount as string, dstAmount: q.destinationAmount, dstAmountMin: q.destinationAmount,
      cctp: { sourceDomain: source.domain, destinationDomain: destination.domain, sender: r.srcWalletAddress as string, recipient: r.dstWalletAddress as string,
        maxFee: q.protocolFee, finality: q.finalityThreshold, quotedAt: q.quotedAt },
      routeSteps: [{ type: q.mode === "fast" ? "CCTP_FAST" : "CCTP_STANDARD", srcChainKey: source.chainKey, dstChainKey: destination.chainKey }],
      userSteps: [], fees: [{ type: "protocol", amount: q.protocolFee, tokenAddress: source.usdc, chainKey: source.chainKey, decimals: 6, symbol: "USDC", description: "Circle protocol fee; network gas is paid separately on both chains." }],
    }];
  });
  return { quotes, rejectedQuotes: result.rejectedQuotes };
}
