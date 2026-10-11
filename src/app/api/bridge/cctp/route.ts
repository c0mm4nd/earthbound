import { NextRequest, NextResponse } from "next/server";
import { cctpApi } from "@/lib/cctp-api";
import { CctpRequestError } from "@/lib/cctp";
import { CCTP_NETWORKS } from "@/lib/cctp-networks";

// Preview is deliberately separate from executable BridgeQuote responses.
// Burn/mint transactions must not be offered before recovery is implemented.
export async function GET() {
  return NextResponse.json({ stage: "development", executionReady: false, networks: CCTP_NETWORKS });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  try {
    return NextResponse.json(await cctpApi.estimate(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CCTP estimate unavailable." },
      { status: error instanceof CctpRequestError ? 400 : 502 },
    );
  }
}
