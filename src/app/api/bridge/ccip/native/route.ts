import { NextRequest, NextResponse } from "next/server";
import { verifyCcipWrappedNative } from "@/lib/ccip-native-rpc";
import { nativeConversionTransaction } from "@/lib/ccip-wrapped-native";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!Number.isSafeInteger(body?.chainId) || typeof body.token !== "string" || typeof body.amount !== "string" ||
        !["wrap", "unwrap"].includes(body.operation)) return NextResponse.json({ error: "Invalid native conversion." }, { status: 400 });
    const tx = nativeConversionTransaction(body.chainId, body.token, body.amount, body.operation);
    await verifyCcipWrappedNative([body.chainId]);
    return NextResponse.json({ ...tx, value: tx.value.toString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Native conversion is unavailable." }, { status: 400 });
  }
}
