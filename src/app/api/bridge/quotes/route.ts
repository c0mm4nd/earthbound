import { NextRequest, NextResponse } from "next/server";
import { formatUnits } from "viem";
import {
  fetchLayerZeroJson,
  fetchStargateApiJson,
  fetchStargateV2ApiJson,
} from "@/lib/layerzero";
import { normalizeBridgeQuoteResponse } from "@/lib/bridge-normalization";
import type {
  BridgeApiProvider,
  BridgeQuote,
  BridgeQuoteResponse,
  BridgeToken,
  QuoteFee,
} from "@/lib/bridge-types";

function getTokenId(
  chainKey?: string | null,
  address?: string | null,
) {
  if (!chainKey || !address) {
    return null;
  }

  return `${chainKey.trim().toLowerCase()}:${address.trim().toLowerCase()}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseFiniteNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function formatUsdAmount(value: number) {
  return value.toFixed(8);
}

function buildQuoteTokenById(tokens?: BridgeToken[]) {
  const tokenById = new Map<string, BridgeToken>();

  for (const token of tokens ?? []) {
    const tokenId = getTokenId(token.chainKey, token.address);

    if (tokenId) {
      tokenById.set(tokenId, token);
    }
  }

  return tokenById;
}

function deriveFeeAmountUsd(
  fee: QuoteFee,
  tokenById: ReadonlyMap<string, BridgeToken>,
) {
  const address = fee.tokenAddress ?? fee.address;
  const token = tokenById.get(getTokenId(fee.chainKey, address) ?? "");
  const existingAmountUsd = parseFiniteNumber(fee.amountUsd);

  if (!fee.amount || !token || !isFiniteNumber(token.price?.usd)) {
    return existingAmountUsd !== null ? fee.amountUsd : undefined;
  }

  try {
    const amount = Number(formatUnits(BigInt(fee.amount), token.decimals));

    if (!Number.isFinite(amount)) {
      return existingAmountUsd !== null ? fee.amountUsd : undefined;
    }

    const computedAmountUsd = amount * token.price.usd;

    if (
      existingAmountUsd !== null &&
      (existingAmountUsd > 0 || !Number.isFinite(computedAmountUsd) || computedAmountUsd <= 0)
    ) {
      return fee.amountUsd;
    }

    return Number.isFinite(computedAmountUsd) && computedAmountUsd > 0
      ? formatUsdAmount(computedAmountUsd)
      : undefined;
  } catch {
    return existingAmountUsd !== null ? fee.amountUsd : undefined;
  }
}

function normalizeQuoteFees(
  quote: BridgeQuote,
  tokenById: ReadonlyMap<string, BridgeToken>,
) {
  const fees = quote.fees?.map((fee) => {
    const tokenAddress = fee.tokenAddress ?? fee.address;
    const token = tokenById.get(getTokenId(fee.chainKey, tokenAddress) ?? "");

    return {
      ...fee,
      address: tokenAddress,
      tokenAddress,
      amountUsd: deriveFeeAmountUsd(fee, tokenById),
      decimals: fee.decimals ?? token?.decimals,
      symbol: fee.symbol ?? token?.symbol,
      name: fee.name ?? token?.name,
    } satisfies QuoteFee;
  });

  const computedFeeUsd = fees?.reduce((sum, fee) => {
    const amountUsd = parseFiniteNumber(fee.amountUsd);
    return amountUsd !== null ? sum + amountUsd : sum;
  }, 0);
  const existingFeeUsd = parseFiniteNumber(quote.feeUsd);
  const feeUsd =
    existingFeeUsd !== null &&
    (existingFeeUsd > 0 || computedFeeUsd === undefined || computedFeeUsd <= 0)
      ? quote.feeUsd
      : computedFeeUsd !== undefined && computedFeeUsd > 0
        ? formatUsdAmount(computedFeeUsd)
        : quote.feeUsd;

  return {
    ...quote,
    fees,
    feeUsd,
  } satisfies BridgeQuote;
}

function normalizeQuoteResponse(data: unknown) {
  const normalizedData = normalizeBridgeQuoteResponse(data);

  if (
    !normalizedData ||
    typeof normalizedData !== "object" ||
    !Array.isArray((normalizedData as BridgeQuoteResponse).quotes)
  ) {
    return normalizedData;
  }

  const response = normalizedData as BridgeQuoteResponse;
  const tokenById = buildQuoteTokenById(response.tokens);

  return {
    ...response,
    quotes: response.quotes.map((quote) => normalizeQuoteFees(quote, tokenById)),
  } satisfies BridgeQuoteResponse;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = request.headers.get("x-bridge-api-key");
    const provider = (body.provider === "layerzero"
      ? "layerzero"
      : body.provider === "stargate-v2"
        ? "stargate-v2"
        : "stargate") as BridgeApiProvider;
    const payload = { ...body };
    delete payload.provider;

    const fetchQuoteJson =
      provider === "layerzero"
        ? (path: string, init?: RequestInit) =>
            fetchLayerZeroJson(path, init, { includeApiKey: true, apiKey })
        : provider === "stargate-v2"
          ? fetchStargateV2ApiJson
          : fetchStargateApiJson;

    const { response, data } = await fetchQuoteJson("/quotes", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message =
        (provider === "stargate-v2" &&
        (data?.code === "UNSUPPORTED_ROUTE" || data?.message === "Unsupported route")
          ? "This route is not supported by Stargate v2 fallback. Add a LayerZero API key and retry Direct API."
          : null) ||
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to request bridge quote.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(normalizeQuoteResponse(data), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to request bridge quote.",
      },
      { status: 500 },
    );
  }
}
