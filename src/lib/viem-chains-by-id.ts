import * as viemChains from "viem/chains";
import type { Chain } from "viem";

// Build a lookup map from chainId → viem Chain object using all exports from viem/chains.
// When duplicate IDs exist, the first one encountered is kept.
const _byId: Record<number, Chain> = {};

for (const value of Object.values(viemChains)) {
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as Chain).id === "number"
  ) {
    const chain = value as Chain;
    if (!(_byId[chain.id])) {
      _byId[chain.id] = chain;
    }
  }
}

export const viemChainById: Record<number, Chain> = _byId;
