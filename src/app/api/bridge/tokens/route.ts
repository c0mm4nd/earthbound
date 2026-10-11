import { NextRequest, NextResponse } from "next/server";
import { fetchLayerZeroJson } from "@/lib/layerzero";
import { getCcipCatalog } from "@/lib/ccip-api";
import { ccipDestinationTokens, mergeBridgeTokens } from "@/lib/ccip";

export async function GET(request: NextRequest) {
  try {
    const search = new URL(request.url).searchParams.toString();
    const path = `/tokens${search ? `?${search}` : ""}`;
    const params = new URL(request.url).searchParams;
    const fromChain = params.get("transferrableFromChainKey");
    const fromToken = params.get("transferrableFromTokenAddress");
    if (Boolean(fromChain) !== Boolean(fromToken)) return NextResponse.json({ error: "Source chain and token must be provided together." }, { status: 400 });
    const [base, ccip] = await Promise.allSettled([fetchLayerZeroJson(path), getCcipCatalog()]);
    const baseOk = base.status === "fulfilled" && base.value.response.ok && Array.isArray(base.value.data?.tokens);
    if (!baseOk && ccip.status === "rejected") throw new Error("Token catalogs are temporarily unavailable.");
    const ccipTokens = ccip.status === "fulfilled"
      ? fromChain && fromToken ? ccipDestinationTokens(ccip.value, fromChain, fromToken) : ccip.value.tokens
      : [];
    const tokens = mergeBridgeTokens(baseOk && base.status === "fulfilled" ? base.value.data.tokens : [], ccipTokens);
    const warnings = [...(!baseOk ? ["Some token routes are temporarily unavailable."] : []), ...(ccip.status === "rejected" ? ["CCIP token routes are temporarily unavailable."] : [])];
    if (ccip.status === "fulfilled") warnings.push(...(ccip.value.warnings ?? []));
    return NextResponse.json({ tokens, warnings });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch tokens.",
      },
      { status: 500 },
    );
  }
}
