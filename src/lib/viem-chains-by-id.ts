import * as viemChains from "viem/chains";
import type { Chain } from "viem";
import { extraEvmChains } from "./extra-evm-chains";

// Build a lookup map from chainId → viem Chain object using all exports from viem/chains.
// When duplicate IDs exist, the first one encountered is kept.
const _byId: Record<number, Chain> = {};

for (const value of [...Object.values(viemChains), ...Object.values(extraEvmChains)]) {
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

export function mergeEvmChains(base: readonly Chain[], chainIds: readonly number[]): readonly Chain[] {
  const chains = new Map(base.map(chain => [chain.id, chain]));
  for (const id of chainIds) {
    if (!chains.has(id) && viemChainById[id]) chains.set(id, viemChainById[id]);
  }
  return [...chains.values()];
}
