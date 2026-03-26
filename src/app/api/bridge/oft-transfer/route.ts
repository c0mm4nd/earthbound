import { NextRequest, NextResponse } from "next/server";
import { fetchLayerZeroOftJson } from "@/lib/layerzero";

function appendSearchParam(searchParams: URLSearchParams, key: string, value: unknown) {
  if (typeof value === "string" && value.trim()) {
    searchParams.set(key, value.trim());
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const apiKey = request.headers.get("x-bridge-api-key");
    const searchParams = new URLSearchParams();

    appendSearchParam(searchParams, "srcChainName", body.srcChainName);
    appendSearchParam(searchParams, "dstChainName", body.dstChainName);
    appendSearchParam(searchParams, "srcAddress", body.srcAddress);
    appendSearchParam(searchParams, "amount", body.amount);
    appendSearchParam(searchParams, "from", body.from);
    appendSearchParam(searchParams, "to", body.to);

    if (typeof body.validate === "boolean") {
      searchParams.set("validate", String(body.validate));
    }

    if (body.options && typeof body.options === "object") {
      searchParams.set("options", JSON.stringify(body.options));
    }

    const path = `/transfer?${searchParams.toString()}`;
    const { response, data } = await fetchLayerZeroOftJson(path, undefined, {
      includeApiKey: true,
      apiKey,
    });

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to build custom OFT transfer.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to build custom OFT transfer.",
      },
      { status: 500 },
    );
  }
}
