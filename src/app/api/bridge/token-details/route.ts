import { NextResponse } from "next/server";
import type { BridgeToken } from "@/lib/bridge-types";
import { fetchStargateWebJson } from "@/lib/layerzero";

type StargateDisplayToken = {
  chainKey: string;
  address: string;
  decimals: number;
  symbol: string;
  name?: string;
  icon?: string;
  isBridgeable?: boolean;
  isVerified?: boolean;
  isPopular?: boolean;
  price?: {
    USD?: number;
  };
};

export async function GET() {
  try {
    const { response, data } = await fetchStargateWebJson("/tokens");
    const tokens = Array.isArray(data)
      ? data.map((token) => {
          const stargateToken = token as StargateDisplayToken;

          return {
            chainKey: stargateToken.chainKey,
            address: stargateToken.address,
            decimals: stargateToken.decimals,
            symbol: stargateToken.symbol,
            name: stargateToken.name ?? stargateToken.symbol,
            icon: stargateToken.icon,
            isBridgeable: stargateToken.isBridgeable,
            isVerified: stargateToken.isVerified,
            isPopular: stargateToken.isPopular,
            price:
              stargateToken.price?.USD !== undefined
                ? { usd: stargateToken.price.USD }
                : undefined,
          } satisfies BridgeToken;
        })
      : [];

    return NextResponse.json({ tokens }, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch Stargate token details.",
      },
      { status: 500 },
    );
  }
}
