import { NextRequest, NextResponse } from "next/server";
import {
  fetchLayerZeroJson,
  fetchStargateApiJson,
  fetchStargateV2ApiJson,
} from "@/lib/layerzero";
import { normalizeBuildUserStepsResponse } from "@/lib/bridge-normalization";
import type { BridgeApiProvider } from "@/lib/bridge-types";

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
    const fetchBuildJson =
      provider === "layerzero"
        ? (path: string, init?: RequestInit) =>
            fetchLayerZeroJson(path, init, { includeApiKey: true, apiKey })
        : provider === "stargate-v2"
          ? fetchStargateV2ApiJson
          : fetchStargateApiJson;
    const { response, data } = await fetchBuildJson("/build-user-steps", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to build user steps.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(normalizeBuildUserStepsResponse(data), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to build user steps.",
      },
      { status: 500 },
    );
  }
}
