import { NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  return NextResponse.json({
    name: "Earthbound",
    description: "Earthbound Stargate bridging frontend powered by Web3Resear.ch",
    url: origin,
    iconUrl: `${origin}/globe.svg`,
  });
}
