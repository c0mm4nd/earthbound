import { NextRequest, NextResponse } from "next/server";
import { fetchLayerZeroJson } from "@/lib/layerzero";

export async function GET(request: NextRequest) {
  try {
    const search = new URL(request.url).searchParams.toString();
    const path = `/tokens${search ? `?${search}` : ""}`;
    const { response, data } = await fetchLayerZeroJson(path);

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch tokens.",
      },
      { status: 500 },
    );
  }
}
