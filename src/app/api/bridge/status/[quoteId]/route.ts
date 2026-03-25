import { NextRequest, NextResponse } from "next/server";
import {
  fetchLayerZeroJson,
  fetchStargateApiJson,
  fetchStargateV2ApiJson,
} from "@/lib/layerzero";
import type { BridgeApiProvider } from "@/lib/bridge-types";

type RouteContext = {
  params: Promise<{
    quoteId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { quoteId } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const apiKey = request.headers.get("x-bridge-api-key");
    const txHash = searchParams.get("txHash");
    const provider = (searchParams.get("provider") === "layerzero"
      ? "layerzero"
      : searchParams.get("provider") === "stargate-v2"
        ? "stargate-v2"
        : "stargate") as BridgeApiProvider;
    const path = txHash
      ? `/status/${encodeURIComponent(quoteId)}?txHash=${encodeURIComponent(txHash)}`
      : `/status/${encodeURIComponent(quoteId)}`;
    const fetchStatusJson =
      provider === "layerzero"
        ? (statusPath: string, init?: RequestInit) =>
            fetchLayerZeroJson(statusPath, init, { includeApiKey: true, apiKey })
        : provider === "stargate-v2"
          ? fetchStargateV2ApiJson
          : fetchStargateApiJson;
    const { response, data } = await fetchStatusJson(path);

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to fetch transfer status.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch transfer status.",
      },
      { status: 500 },
    );
  }
}
