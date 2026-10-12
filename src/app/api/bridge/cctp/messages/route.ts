import { NextRequest, NextResponse } from "next/server";
import { assertCctpTransfer } from "@/lib/cctp-evm";
import { assertCctpMessage, selectCctpAttestation } from "@/lib/cctp-message";

export async function POST(request: NextRequest) {
  let input;
  try {
    input = await request.json();
    assertCctpTransfer(input.transfer);
    if (!input.transfer.burnHash || !input.transfer.sourceMessage) throw new Error("Verify the source burn before requesting its proof.");
    assertCctpMessage(input.transfer.sourceMessage, input.transfer, false);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid CCTP request." }, { status: 400 });
  }
  try {
    const transfer = input.transfer;
    const url = `https://iris-api.circle.com/v2/messages/${transfer.sourceDomain}?transactionHash=${transfer.burnHash}`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (response.status === 404) return NextResponse.json({ messages: [] }, { headers: { "Cache-Control": "no-store" } });
    if (!response.ok) throw new Error(`Circle attestation service unavailable (HTTP ${response.status}).`);
    const data = await response.json();
    if (input.reattest === true) {
      const proof = selectCctpAttestation(data, transfer);
      if (!proof) throw new Error("Wait for Circle to produce a matching message before requesting a new proof.");
      const message = assertCctpMessage(proof.message, transfer, true);
      const renewed = await fetch(`https://iris-api.circle.com/v2/reattest/${message.nonce}`, { method: "POST", signal: AbortSignal.timeout(12_000) });
      if (!renewed.ok) throw new Error(`Circle could not renew this proof (HTTP ${renewed.status}).`);
      return NextResponse.json({ messages: [], renewalRequested: true });
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CCTP tracking unavailable." }, { status: 502 });
  }
}
