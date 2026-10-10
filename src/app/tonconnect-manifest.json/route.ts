import { NextRequest, NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/app-origin";

export function GET(request: NextRequest) {
  const origin = getAppOrigin(request.headers);

  return NextResponse.json({
    name: "Earthbound",
    description: "Earthbound cross-chain bridge powered by Web3Resear.ch",
    url: origin,
    iconUrl: `${origin}/globe.svg`,
  });
}
