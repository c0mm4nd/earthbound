import { decodeEventLog, encodeFunctionData, erc20Abi, isAddress, pad, parseAbi, zeroAddress, zeroHash, type Address, type Hex, type TransactionReceipt } from "viem";
import { cctpNetwork, isCctpUsdc } from "./cctp";
import type { BridgeQuote, BridgeToken } from "./bridge-types";
import type { CcipQuoteRequest } from "./ccip";

// Circle V2 deployment addresses; domain identity is also checked onchain before burn.
// https://developers.circle.com/cctp/references/contract-addresses
const EVM_DOMAINS: Array<[number, number, string]> = [
  [0, 1, "ethereum"], [1, 43114, "avalanche"], [2, 10, "optimism"], [3, 42161, "arbitrum"],
  [6, 8453, "base"], [7, 137, "polygon"], [10, 130, "unichain"], [11, 59144, "linea"],
  [12, 81224, "codex"], [13, 146, "sonic"], [14, 480, "worldchain"], [15, 143, "monad"],
  [16, 1329, "sei"], [18, 50, "xdc"], [19, 999, "hyperliquid"], [21, 57073, "ink"],
  [22, 98866, "plumephoenix"], [26, 5042, "arc"], [28, 3343, "ccip-edge-mainnet"],
  [29, 1776, "injectiveevm"], [30, 2818, "morph"], [31, 1672, "pharos"],
  [32, 25, "cronosevm"], [33, 9745, "plasma"], [37, 196, "xlayer"],
];
export const CCTP_EVM = EVM_DOMAINS.map(([domain, chainId, chainKey]) => ({
  ...cctpNetwork(domain), chainId, chainKey,
  messenger: (domain === 28 ? "0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c" : "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d").toLowerCase() as Address,
  transmitter: (domain === 28 ? "0x5b61381Fc9e58E70EfC13a4A97516997019198ee" : "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64").toLowerCase() as Address,
}));
export function cctpEvm(domain: number) {
  const config = CCTP_EVM.find(item => item.domain === domain);
  if (!config) throw new Error("CCTP execution for this network is still in development.");
  return config;
}
export function cctpEvmForKey(key: string) {
  return CCTP_EVM.find(item => item.chainKey === key);
}
export function supportsCctpPair(source: BridgeToken | null, destination: BridgeToken | null) {
  const src = source && cctpEvmForKey(source.chainKey), dst = destination && cctpEvmForKey(destination.chainKey);
  return Boolean(src && dst && src.domain !== dst.domain && isCctpUsdc(src, source!.address) && isCctpUsdc(dst, destination!.address));
}
export const CCTP_ABI = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
  "function receiveMessage(bytes message,bytes attestation) returns(bool)",
  "function localDomain() view returns(uint32)",
  "function localMessageTransmitter() view returns(address)",
  "function remoteTokenMessengers(uint32 domain) view returns(bytes32)",
  "function localMinter() view returns(address)",
  "function burnLimitsPerMessage(address token) view returns(uint256)",
  "function paused() view returns(bool)",
  "function usedNonces(bytes32 nonce) view returns(uint256)",
  "function signatureThreshold() view returns(uint256)",
  "function isEnabledAttester(address attester) view returns(bool)",
  "event MessageSent(bytes message)",
]);

export type CctpTransfer = {
  sourceDomain: number; destinationDomain: number; sender: string; recipient: string;
  amount: string; maxFee: string; finality: 1000 | 2000;
  burnHash?: string; claimHash?: string; sourceMessage?: Hex;
  state: "preparing" | "burn_pending" | "attestation_pending" | "ready" | "claim_pending" | "complete" | "failed";
};
export const CCTP_STATE_LABELS: Record<CctpTransfer["state"], string> = {
  preparing: "Preparing CCTP", burn_pending: "Confirming USDC burn", attestation_pending: "Waiting for Circle proof",
  ready: "Ready to claim", claim_pending: "Confirming claim", complete: "Transfer completed", failed: "Transfer failed",
};
const uint = (value: unknown) => typeof value === "string" && /^\d{1,78}$/.test(value) && BigInt(value) < BigInt(2) ** BigInt(256);
export function assertCctpTransfer(value: unknown): asserts value is CctpTransfer {
  if (!value || typeof value !== "object") throw new Error("Invalid CCTP transfer.");
  const t = value as CctpTransfer;
  const source = cctpEvm(t.sourceDomain); cctpEvm(t.destinationDomain);
  if (t.sourceDomain === t.destinationDomain || !uint(t.amount) || BigInt(t.amount) <= BigInt(0) || !uint(t.maxFee) || BigInt(t.maxFee) >= BigInt(t.amount) ||
      ![1000, 2000].includes(t.finality) || (t.finality === 1000 && !source.fastSource) ||
      ![t.sender, t.recipient].every(a => typeof a === "string" && isAddress(a, { strict: false }) && a.toLowerCase() !== zeroAddress) ||
      !["preparing", "burn_pending", "attestation_pending", "ready", "claim_pending", "complete", "failed"].includes(t.state) ||
      [t.burnHash, t.claimHash].some(h => h !== undefined && (typeof h !== "string" || !/^0x[\da-f]{64}$/i.test(h))) ||
      (t.sourceMessage !== undefined && (typeof t.sourceMessage !== "string" || !/^0x[\da-f]{752}$/i.test(t.sourceMessage)))) {
    throw new Error("Invalid CCTP transfer.");
  }
}
export function cctpTransferKey(t: CctpTransfer) {
  return JSON.stringify([t.sourceDomain, t.destinationDomain, t.sender.toLowerCase(), t.recipient.toLowerCase(), t.amount]);
}
export function transferFromCctpQuote(quote: BridgeQuote): CctpTransfer {
  if (quote.provider !== "cctp" || !quote.cctp) throw new Error("Missing CCTP quote.");
  const t: CctpTransfer = { ...quote.cctp, amount: quote.srcAmount, state: "preparing" };
  assertCctpTransfer(t);
  if (quote.dstAmountMin !== (BigInt(t.amount) - BigInt(t.maxFee)).toString()) throw new Error("CCTP minimum received amount changed.");
  return t;
}
export function assertCctpQuote(quote: BridgeQuote, request: CcipQuoteRequest) {
  const t = transferFromCctpQuote(quote);
  const source = cctpEvm(t.sourceDomain), destination = cctpEvm(t.destinationDomain);
  if (source.chainKey !== request.srcChainKey || destination.chainKey !== request.dstChainKey ||
      !isCctpUsdc(source, request.srcTokenAddress) || !isCctpUsdc(destination, request.dstTokenAddress) ||
      request.amount !== t.amount || request.srcWalletAddress?.toLowerCase() !== t.sender.toLowerCase() ||
      request.dstWalletAddress.toLowerCase() !== t.recipient.toLowerCase() ||
      !Number.isFinite(quote.cctp!.quotedAt) || Date.now() - quote.cctp!.quotedAt > 60_000 || quote.cctp!.quotedAt > Date.now() + 5000 ||
      quote.routeSteps.length !== 1 || quote.routeSteps[0].srcChainKey !== source.chainKey || quote.routeSteps[0].dstChainKey !== destination.chainKey) {
    throw new Error("CCTP quote no longer matches this transfer. Request a new quote.");
  }
  return t;
}
export function cctpBurnTransaction(t: CctpTransfer) {
  assertCctpTransfer(t);
  const source = cctpEvm(t.sourceDomain);
  return { to: source.messenger, value: BigInt(0), data: encodeFunctionData({ abi: CCTP_ABI, functionName: "depositForBurn", args: [
    BigInt(t.amount), t.destinationDomain, pad(t.recipient as Address), source.usdc as Address, zeroHash, BigInt(t.maxFee), t.finality,
  ] }) };
}
export function cctpApproveTransaction(t: CctpTransfer, amount: bigint) {
  const source = cctpEvm(t.sourceDomain);
  return { to: source.usdc as Address, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [source.messenger, amount] }) };
}
export function cctpSourceMessage(receipt: Pick<TransactionReceipt, "status" | "logs">, t: CctpTransfer): Hex {
  if (receipt.status !== "success") throw new Error("CCTP burn transaction reverted.");
  const transmitter = cctpEvm(t.sourceDomain).transmitter;
  const messages = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== transmitter) return [];
    try {
      const event = decodeEventLog({ abi: CCTP_ABI, eventName: "MessageSent", data: log.data, topics: log.topics });
      return [event.args.message];
    } catch { return []; }
  });
  if (messages.length !== 1) throw new Error("Expected exactly one CCTP burn message. Check the source transaction.");
  return messages[0];
}
