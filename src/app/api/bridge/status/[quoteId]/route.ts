import { NextRequest, NextResponse } from "next/server";
import { fetchStargateApiJson } from "@/lib/layerzero";

type RouteContext = {
  params: Promise<{
    quoteId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { quoteId } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const txHash = searchParams.get("txHash");
    const path = txHash
      ? `/status/${encodeURIComponent(quoteId)}?txHash=${encodeURIComponent(txHash)}`
      : `/status/${encodeURIComponent(quoteId)}`;
    const { response, data } = await fetchStargateApiJson(path);

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
