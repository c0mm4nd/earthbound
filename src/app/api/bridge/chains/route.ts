import { NextRequest, NextResponse } from "next/server";
import { fetchLayerZeroJson } from "@/lib/layerzero";
import { getCcipCatalog } from "@/lib/ccip-api";
import type { BridgeChain } from "@/lib/bridge-types";
import { cctpBridgeChains } from "@/lib/cctp-bridge";

export async function GET(request: NextRequest) {
  try {
    const search = new URL(request.url).searchParams.toString();
    const path = `/chains${search ? `?${search}` : ""}`;
    const [base, ccip] = await Promise.allSettled([fetchLayerZeroJson(path), getCcipCatalog()]);
    const baseOk = base.status === "fulfilled" && base.value.response.ok && Array.isArray(base.value.data?.chains);
    if (!baseOk && ccip.status === "rejected" && !cctpBridgeChains().length) throw new Error("Chain catalogs are temporarily unavailable.");
    const chains = new Map<string, BridgeChain>((baseOk && base.status === "fulfilled" ? base.value.data.chains : []).map((chain: BridgeChain) => [chain.chainKey, chain]));
    if (ccip.status === "fulfilled") for (const chain of ccip.value.chains) if (!chains.has(chain.chainKey)) chains.set(chain.chainKey, chain);
    for (const chain of cctpBridgeChains()) if (!chains.has(chain.chainKey)) chains.set(chain.chainKey, chain);
    const warnings = [...(!baseOk ? ["Some networks are temporarily unavailable."] : []), ...(ccip.status === "rejected" ? ["CCIP networks are temporarily unavailable."] : [])];
    if (ccip.status === "fulfilled") warnings.push(...(ccip.value.warnings ?? []));
    return NextResponse.json({ chains: [...chains.values()], warnings });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch chains.",
      },
      { status: 500 },
    );
  }
}
