import { NextRequest, NextResponse } from "next/server";
import { assertCctpNativeTransfer, monitorNativeCctp } from "@/lib/cctp-native-lifecycle";
import { nativeCctpMonitor, nativeCctpReader, prepareNativeCctp } from "@/lib/cctp-native-service";
import { assertCctpNativeMessage } from "@/lib/cctp-native-proof";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let input;
  try {
    const body = await request.text();
    if (body.length > 24_000) throw new Error("CCTP request is too large.");
    input = JSON.parse(body);
    assertCctpNativeTransfer(input.transfer);
    if (!["status", "renew", "receipt", "prepare", "burn", "claim"].includes(input.action)) throw new Error("Invalid CCTP action.");
    if (["prepare", "burn", "claim"].includes(input.action) && typeof input.payer !== "string") throw new Error("Connect a signing wallet.");
    if (input.action === "receipt" && (![input.transfer.sourceDomain, input.transfer.destinationDomain].includes(input.domain) || typeof input.hash !== "string")) throw new Error("Invalid receipt request.");
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid CCTP request." }, { status: 400 }); }
  try {
    const t = input.transfer;
    let result;
    if (input.action === "receipt") result = await nativeCctpReader(input.domain, input.domain === t.sourceDomain ? t.destinationDomain : t.sourceDomain).receipt(input.hash);
    else if (["status", "renew"].includes(input.action)) {
      result = await monitorNativeCctp(t, nativeCctpMonitor(t));
      if (input.action === "renew") {
        if (!result.proof || result.transfer.state !== "ready") throw new Error("This proof cannot be renewed yet.");
        const { nonce } = assertCctpNativeMessage(t, result.proof.message, true);
        const response = await fetch(`https://iris-api.circle.com/v2/reattest/${nonce}`, { method: "POST", signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new Error("Circle could not renew this proof.");
        result = { transfer: { ...result.transfer, state: "attestation_pending" }, renewalRequested: true };
      }
    } else result = await prepareNativeCctp(t, input.action, input.payer);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "CCTP service unavailable." }, { status: 502 }); }
}
