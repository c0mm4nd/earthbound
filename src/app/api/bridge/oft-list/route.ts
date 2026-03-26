import { NextRequest, NextResponse } from "next/server";
import { fetchLayerZeroOftJson } from "@/lib/layerzero";

export async function GET(request: NextRequest) {
  try {
    const search = new URL(request.url).searchParams.toString();
    const path = `/list${search ? `?${search}` : ""}`;
    const { response, data } = await fetchLayerZeroOftJson(path);

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to discover OFTs.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to discover OFTs.",
      },
      { status: 500 },
    );
  }
}
