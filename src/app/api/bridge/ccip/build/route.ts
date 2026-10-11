import { NextRequest, NextResponse } from "next/server";
import { getCcipCatalog, getCcipQuote } from "@/lib/ccip-api";
import { resolveCcipQuote, type CcipQuoteRequest } from "@/lib/ccip";
import { buildCcipSolanaStep } from "@/lib/ccip-solana";
import { ccipAptosStep } from "@/lib/ccip-aptos";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || typeof body.srcWalletAddress !== "string" ||
        typeof body.maxNativeFee !== "string" || !/^\d{1,78}$/.test(body.maxNativeFee) ||
        typeof body.minDstAmount !== "string" || !/^\d{1,78}$/.test(body.minDstAmount)) {
      return NextResponse.json({ error: "A reviewed CCIP transfer and source wallet are required." }, { status: 400 });
    }
    const response = await getCcipQuote(body);
    const quote = response.quotes[0];
    if (!quote?.ccip || BigInt(quote.ccip.nativeFee) > BigInt(body.maxNativeFee) || BigInt(quote.dstAmount) < BigInt(body.minDstAmount)) {
      return NextResponse.json({ error: "CCIP quote changed. Refresh and review before sending." }, { status: 409 });
    }
    const { srcChain, dstChain } = resolveCcipQuote(await getCcipCatalog(), body as CcipQuoteRequest);
    const step = srcChain.chainType === "SOLANA"
      ? await buildCcipSolanaStep(srcChain, dstChain, body, BigInt(quote.ccip.nativeFee))
      : srcChain.chainType === "APTOS" ? ccipAptosStep(quote, srcChain.chainKey) : null;
    if (!step) return NextResponse.json({ error: "Unsupported CCIP source builder." }, { status: 400 });
    return NextResponse.json({ quote, userSteps: [step] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message ? error.message : "Unable to build CCIP transfer. Check the source token account and RPC connection." }, { status: 502 });
  }
}
