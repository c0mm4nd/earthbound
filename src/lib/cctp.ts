import { CCTP_NETWORKS, type CctpNetwork } from "./cctp-networks";

export class CctpRequestError extends Error {}

export function cctpNetwork(domain: unknown): CctpNetwork {
  const network = CCTP_NETWORKS.find((item) => item.domain === domain);
  if (!network) throw new CctpRequestError("Unsupported CCTP USDC mainnet domain.");
  return network;
}

/** Identity comes from Circle's native token address, never from its symbol. */
export function isCctpUsdc(network: CctpNetwork, token: unknown): boolean {
  if (typeof token !== "string") return false;
  if (network.family === "EVM") return token.toLowerCase() === network.usdc.toLowerCase();
  if (network.family === "APTOS" || network.family === "STARKNET") {
    return /^0x[\da-f]{1,64}$/i.test(token) && BigInt(token) === BigInt(network.usdc);
  }
  if (network.family === "SUI") {
    const [address, module, name, extra] = token.split("::");
    return extra === undefined && module === "usdc" && name === "USDC" &&
      /^0x[\da-f]{1,64}$/i.test(address) && BigInt(address) === BigInt(network.usdc.split("::")[0]);
  }
  return token === network.usdc; // Solana and Stellar identifiers are case-sensitive.
}

/** Decimal input without Number conversion, truncation or scientific notation. */
export function cctpUnits(value: unknown, decimals: number): bigint {
  if (typeof value !== "string" || value.length > 90 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new CctpRequestError("Enter a decimal USDC amount as a string.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new CctpRequestError(`USDC supports at most ${decimals} decimal places on this network.`);
  const amount = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (amount >= BigInt(2) ** BigInt(256)) throw new CctpRequestError("USDC amount is too large.");
  return amount;
}

export function prepareCctpEstimate(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CctpRequestError("Invalid CCTP estimate request.");
  const request = body as Record<string, unknown>;
  const source = cctpNetwork(request.sourceDomain);
  const destination = cctpNetwork(request.destinationDomain);
  if (source.domain === destination.domain) throw new CctpRequestError("Choose different source and destination networks.");
  if (!isCctpUsdc(source, request.sourceToken) || !isCctpUsdc(destination, request.destinationToken)) {
    throw new CctpRequestError("CCTP requires Circle-issued native USDC on both networks.");
  }
  const sourceAmount = cctpUnits(request.amount, source.decimals);
  // Stellar leaves seventh-decimal dust in the source wallet. Expose it explicitly.
  const scale = BigInt(10) ** BigInt(source.decimals - 6);
  const messageAmount = sourceAmount / scale;
  if (messageAmount === BigInt(0)) throw new CctpRequestError("Transfer at least 0.000001 USDC.");
  return { source, destination, sourceAmount, messageAmount, sourceDust: sourceAmount % scale };
}

export interface CctpFeeRate {
  finalityThreshold: 1000 | 2000;
  minimumFee: string;
}

export function parseCctpFeeRates(data: unknown): CctpFeeRate[] {
  if (!Array.isArray(data) || data.length === 0 || data.length > 2) throw new Error("Invalid Circle fee response.");
  const seen = new Set<number>();
  return data.map((item) => {
    if (!item || typeof item !== "object" || ![1000, 2000].includes(item.finalityThreshold) || seen.has(item.finalityThreshold)) {
      throw new Error("Invalid Circle finality threshold.");
    }
    seen.add(item.finalityThreshold);
    const rate = typeof item.minimumFee === "number" ? String(item.minimumFee) : item.minimumFee;
    // Circle supplies basis points; six decimal places allow sub-basis-point fees.
    if (typeof rate !== "string" || !/^(0|[1-9]\d{0,4})(\.\d{1,6})?$/.test(rate) || cctpUnits(rate, 6) >= BigInt(10_000_000_000)) {
      throw new Error("Invalid Circle fee rate.");
    }
    return { finalityThreshold: item.finalityThreshold, minimumFee: rate };
  });
}

export function cctpFeeAmount(amount: bigint, basisPoints: string): bigint {
  const numerator = amount * cctpUnits(basisPoints, 6);
  const denominator = BigInt(10_000_000_000);
  // Round upward: an estimated fee must never understate a fractional micro-USDC.
  return (numerator + denominator - BigInt(1)) / denominator;
}

export function buildCctpEstimates(body: unknown, feeData: unknown, quotedAt = Date.now()) {
  const { source, destination, sourceAmount, messageAmount, sourceDust } = prepareCctpEstimate(body);
  const rejectedQuotes: Array<{ mode: string; error: string }> = [];
  const quotes = parseCctpFeeRates(feeData).flatMap((rate) => {
    const fast = rate.finalityThreshold === 1000;
    if (fast && !source.fastSource) return [];
    const mode = fast ? "fast" : "standard";
    const fee = cctpFeeAmount(messageAmount, rate.minimumFee);
    if (fee >= messageAmount) {
      rejectedQuotes.push({ mode, error: "Amount is too small to cover the CCTP fee." });
      return [];
    }
    const destinationAmount = (messageAmount - fee) * BigInt(10) ** BigInt(destination.decimals - 6);
    return [{
      provider: "cctp" as const,
      mode,
      executionReady: false as const,
      sourceDomain: source.domain,
      destinationDomain: destination.domain,
      sourceToken: source.usdc,
      destinationToken: destination.usdc,
      sourceDecimals: source.decimals,
      destinationDecimals: destination.decimals,
      requestedSourceAmount: sourceAmount.toString(),
      sourceAmount: (sourceAmount - sourceDust).toString(),
      sourceDust: sourceDust.toString(),
      messageAmount: messageAmount.toString(),
      destinationAmount: destinationAmount.toString(),
      protocolFee: fee.toString(),
      protocolFeeDecimals: 6,
      minimumFeeBps: rate.minimumFee,
      finalityThreshold: rate.finalityThreshold,
      gasIncluded: false,
      forwardingIncluded: false,
      requiresStellarForwarder: destination.family === "STELLAR",
      fastAllowanceChecked: false,
      quotedAt,
      expiresAt: quotedAt + 30_000,
    }];
  });
  return { stage: "development" as const, executionReady: false as const, quotes, rejectedQuotes };
}
