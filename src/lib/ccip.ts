import { ccipAddressKey, isCcipAddress } from "./ccip-addresses";
import { formatUnits, zeroAddress } from "viem";
import { assertNativeConversionAmount, wrappedNativeForChain } from "./ccip-wrapped-native";
import { ccipNativeNetwork, isCcipNative } from "./ccip-native";
import type { BridgeChain, BridgeQuoteResponse, BridgeToken, QuoteFee } from "./bridge-types";

export interface CcipChain extends BridgeChain {
  ccip: { selectorName: string; router: string; selector?: string };
}

export interface CcipCatalog {
  chains: CcipChain[];
  tokens: BridgeToken[];
  warnings?: string[];
}

export interface CcipQuoteRequest {
  srcChainKey: string;
  dstChainKey: string;
  srcTokenAddress: string;
  dstTokenAddress: string;
  dstWalletAddress: string;
  amount: string;
  srcWalletAddress?: string;
}

export function ccipTransferKey(request: CcipQuoteRequest, sender: string) {
  return JSON.stringify([request.srcChainKey, request.dstChainKey, ccipAddressKey(request.srcTokenAddress), ccipAddressKey(request.dstTokenAddress),
    BigInt(request.amount).toString(), ccipAddressKey(request.dstWalletAddress), ccipAddressKey(sender)]);
}

// Hex addresses are case insensitive; Solana addresses must retain their case.
export function bridgeTokenKey(token: Pick<BridgeToken, "chainKey" | "address">) {
  const address = token.address.startsWith("0x") ? token.address.toLowerCase() : token.address;
  return `${token.chainKey}:${address}`;
}

export function mergeBridgeTokens(base: BridgeToken[], ccip: BridgeToken[]) {
  const tokens = new Map<string, BridgeToken>(base.map(token => [bridgeTokenKey(token), {
    ...token, bridgeProviders: ["layerzero"] as BridgeToken["bridgeProviders"],
  }]));
  for (const token of ccip) {
    const key = bridgeTokenKey(token);
    const existing = tokens.get(key);
    tokens.set(key, existing ? {
      ...token, ...existing, ccip: token.ccip,
      bridgeProviders: ["layerzero", "ccip"],
    } : token);
  }
  return [...tokens.values()];
}

export function ccipDestinationTokens(catalog: CcipCatalog, chainKey: string, address: string) {
  const source = catalog.tokens.find(token => bridgeTokenKey(token) === bridgeTokenKey({ chainKey, address }));
  const destinations = new Set(source?.ccip?.destinations.map(bridgeTokenKey));
  return catalog.tokens.filter(token => destinations.has(bridgeTokenKey(token)));
}

export function supportsCcipPair(source: BridgeToken | null, destination: BridgeToken | null) {
  return Boolean(destination && source?.ccip?.destinations.some(token => bridgeTokenKey(token) === bridgeTokenKey(destination)));
}

function unsignedAmount(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 78 || BigInt(value) >= BigInt(2) ** BigInt(256)) {
    throw new Error(`Invalid ${label}.`);
  }
  return BigInt(value);
}

export function resolveCcipQuote(catalog: CcipCatalog, request: CcipQuoteRequest) {
  const srcChain = catalog.chains.find(chain => chain.chainKey === request.srcChainKey);
  const dstChain = catalog.chains.find(chain => chain.chainKey === request.dstChainKey);
  const srcToken = catalog.tokens.find(token => bridgeTokenKey(token) === bridgeTokenKey({ chainKey: request.srcChainKey, address: request.srcTokenAddress }));
  const dstToken = catalog.tokens.find(token => bridgeTokenKey(token) === bridgeTokenKey({ chainKey: request.dstChainKey, address: request.dstTokenAddress }));
  if (!srcChain || !dstChain || !srcToken || !dstToken || srcChain.chainKey === dstChain.chainKey || !supportsCcipPair(srcToken, dstToken)) {
    throw new Error("CCIP does not support this token pair and direction.");
  }
  if (!["EVM", "SOLANA", "APTOS", "CANTON"].includes(srcChain.chainType) ||
      !["EVM", "SOLANA", "APTOS", "CANTON"].includes(dstChain.chainType)) {
    throw new Error("This chain family has no supported CCIP mainnet route.");
  }
  if (!isCcipAddress(dstChain.chainType, request.dstWalletAddress)) {
    throw new Error("Enter a valid CCIP destination address.");
  }
  let native;
  let wrapping;
  const sourceIsNative = srcChain.chainType === "EVM" && isCcipNative(srcToken.address);
  const destinationIsNative = dstChain.chainType === "EVM" && isCcipNative(dstToken.address);
  if (sourceIsNative || destinationIsNative) {
    const source = ccipNativeNetwork(srcChain), destination = ccipNativeNetwork(dstChain);
    if (sourceIsNative && destinationIsNative && source && destination) {
      if (!isCcipAddress("EVM", request.srcWalletAddress ?? "")) throw new Error("Connect the source wallet to quote a native CCIP transfer.");
      if (ccipAddressKey(request.srcWalletAddress!) !== ccipAddressKey(request.dstWalletAddress)) throw new Error("Native CCIP transfers arrive at the source wallet's same address on the destination network.");
      native = { source, destination };
    } else {
      const source = sourceIsNative ? wrappedNativeForChain(srcChain) : undefined;
      const destination = destinationIsNative ? wrappedNativeForChain(dstChain) : undefined;
      if ((sourceIsNative && (!source || srcToken.decimals !== 18)) || (destinationIsNative && (!destination || dstToken.decimals !== 18))) throw new Error("This native CCIP route is not supported.");
      wrapping = { source: source?.token, destination: destination?.token, destinationChainId: dstChain.chainId };
    }
  }
  const amount = unsignedAmount(request.amount, "CCIP amount");
  if (wrapping?.source) assertNativeConversionAmount(srcChain.chainId, request.amount, "wrap");
  if (amount === BigInt(0)) throw new Error("CCIP amount must be greater than zero.");
  if (["SOLANA", "APTOS"].includes(srcChain.chainType) && amount >= BigInt(2) ** BigInt(64)) throw new Error("CCIP amount exceeds the source chain limit.");
  return { srcChain, dstChain, srcToken, dstToken, amount, native, wrapping };
}

export function ccipFeeQuery(catalog: CcipCatalog, request: CcipQuoteRequest) {
  const { srcChain, dstChain, srcToken, amount, native, wrapping } = resolveCcipQuote(catalog, request);
  return new URLSearchParams({
    sourceChainSelectorName: srcChain.ccip.selectorName,
    destChainSelectorName: dstChain.ccip.selectorName,
    routerAddress: native?.source.wrapper ?? srcChain.ccip.router,
    receiver: native?.destination.wrapper ?? request.dstWalletAddress,
    token: native ? zeroAddress : wrapping?.source ?? srcToken.address,
    // Transporter expects a decimal token amount, not base units.
    amount: formatUnits(amount, srcToken.decimals),
    tokenDecimals: String(srcToken.decimals),
    finality: "0",
  });
}

export function normalizeCcipQuote(
  catalog: CcipCatalog,
  request: CcipQuoteRequest,
  data: unknown,
  estimatedMilliseconds?: number,
): BridgeQuoteResponse {
  const { srcChain, dstChain, srcToken, dstToken, amount, native: nativeRoute, wrapping } = resolveCcipQuote(catalog, request);
  if (!data || typeof data !== "object" || !("ccipFee" in data)) throw new Error("CCIP returned an invalid fee estimate.");
  const nativeFee = unsignedAmount(data.ccipFee, "CCIP fee");
  // Review a 1% fee ceiling, but send only the current router fee.
  const maxNativeFee = (nativeFee * BigInt(101) + BigInt(99)) / BigInt(100);
  const validSelector = (value?: string) => value && /^\d{1,20}$/.test(value) && BigInt(value) > BigInt(0) && BigInt(value) < BigInt(2) ** BigInt(64);
  if (!validSelector(srcChain.ccip.selector) || !validSelector(dstChain.ccip.selector) || !(srcChain.chainType === "CANTON" ? srcChain.ccip.router.includes("@") : isCcipAddress(srcChain.chainType, srcChain.ccip.router))) {
    throw new Error("CCIP execution configuration is unavailable for this route. Try again shortly.");
  }
  const transferFee = "tokenTransferFee" in data ? data.tokenTransferFee : undefined;
  if (transferFee != null && (typeof transferFee !== "object" || Array.isArray(transferFee))) throw new Error("Invalid CCIP transfer fee.");
  const deducted = transferFee && "feeDeducted" in transferFee ? unsignedAmount(transferFee.feeDeducted, "CCIP transfer fee") : BigInt(0);
  if (deducted >= amount) throw new Error("CCIP transfer fee consumes the entire amount.");
  const dstAmount = (amount - deducted) * BigInt(10) ** BigInt(dstToken.decimals) / BigInt(10) ** BigInt(srcToken.decimals);
  if (wrapping?.destination) assertNativeConversionAmount(dstChain.chainId, dstAmount.toString(), "unwrap");
  if (dstAmount === BigInt(0)) throw new Error("Amount is too small for the destination token precision.");
  const native = srcChain.nativeCurrency;
  const fees: QuoteFee[] = [{
    type: "CCIP", amount: maxNativeFee.toString(), chainKey: srcChain.chainKey,
    tokenAddress: native.address, decimals: native.decimals, symbol: native.symbol,
    name: srcChain.chainType === "EVM" ? "Maximum CCIP fee" : "Estimated CCIP fee",
    description: srcChain.chainType === "EVM" ? "Includes a 1% fee ceiling. Only the current fee is sent; source network gas is additional."
      : "Includes a 1% estimate buffer. The source router charges its fee at execution; network gas is additional.",
  }];
  if (deducted > BigInt(0)) fees.push({
    type: "TOKEN_TRANSFER", amount: deducted.toString(), chainKey: srcChain.chainKey,
    tokenAddress: srcToken.address, decimals: srcToken.decimals, symbol: srcToken.symbol,
    name: "Token transfer fee", description: "Deducted from the transferred amount.",
  });
  return { quotes: [{
    id: `ccip:${srcChain.ccip.selector}:${dstChain.ccip.selector}:${Date.now()}`,
    provider: "ccip",
    ccip: {
      router: nativeRoute?.source.wrapper ?? srcChain.ccip.router,
      wrapping,
      native: nativeRoute ? { destinationWrapper: nativeRoute.destination.wrapper, sourceWrappedToken: nativeRoute.source.wrappedToken, destinationWrappedToken: nativeRoute.destination.wrappedToken } : undefined,
      sourceSelector: srcChain.ccip.selector!, destinationSelector: dstChain.ccip.selector!,
      sourceChainId: srcChain.chainId, sourceFamily: srcChain.chainType, destinationFamily: dstChain.chainType, sourceToken: srcToken.address, destinationToken: dstToken.address,
      receiver: request.dstWalletAddress, nativeFee: nativeFee.toString(), maxNativeFee: maxNativeFee.toString(), quotedAt: Date.now(),
    },
    srcAmount: amount.toString(), dstAmount: dstAmount.toString(),
    routeSteps: [{ type: "CCIP", srcChainKey: srcChain.chainKey, dstChainKey: dstChain.chainKey }],
    userSteps: [], fees,
    duration: estimatedMilliseconds && Number.isFinite(estimatedMilliseconds) && estimatedMilliseconds > 0
      ? { estimated: String(estimatedMilliseconds) } : undefined,
  }], tokens: [srcToken, dstToken, native] };
}
