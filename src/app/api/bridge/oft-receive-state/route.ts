import { NextRequest, NextResponse } from "next/server";
import { readNonEvmReceiveState } from "@/lib/direct-oft-receive-state";

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    if (body.length > 2048) return NextResponse.json({ error: "Request too large." }, { status: 400 });
    return NextResponse.json(await readNonEvmReceiveState(JSON.parse(body)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to validate destination OFT." }, { status: 422 });
  }
}
