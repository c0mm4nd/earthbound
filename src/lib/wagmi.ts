"use client";

import {
  abstract,
  arbitrum,
  avalanche,
  base,
  bsc,
  hemi,
  hyperliquid,
  linea,
  mainnet,
  manta,
  metis,
  optimism,
  plasma,
  polygon,
  scroll,
  somnia,
  soneium,
  unichain,
  worldchain,
  zircuit,
} from "viem/chains";
import type { Chain } from "viem";
import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { type RpcConfig, getEffectiveRpcUrls } from "./rpc-config";
import { extraEvmChains } from "./extra-evm-chains";

export const walletChainByKey = {
  abstract,
  arbitrum,
  avalanche,
  base,
  bsc,
  ethereum: mainnet,
  hemi,
  hyperliquid,
  linea,
  manta,
  metis,
  optimism,
  plasma,
  polygon,
  ...extraEvmChains,
  scroll,
  somnia,
  soneium,
  unichain,
  worldchain,
  zircuit,
} as const;

export const walletChains = [
  mainnet,
  arbitrum,
  base,
  optimism,
  bsc,
  avalanche,
  linea,
  polygon,
  abstract,
  hemi,
  hyperliquid,
  manta,
  metis,
  plasma,
  ...Object.values(extraEvmChains),
  scroll,
  somnia,
  soneium,
  unichain,
  worldchain,
  zircuit,
] as const;

export type WalletChainKey = keyof typeof walletChainByKey;
export type SupportedChainId = (typeof walletChains)[number]["id"];

const chainKeyById: Record<number, string> = Object.fromEntries(
  Object.entries(walletChainByKey).map(([key, chain]) => [chain.id, key]),
);

// Settings and transports must use the same key for dynamically loaded chains.
export function getEvmRpcKey(chain: Pick<Chain, "id">): string {
  return chainKeyById[chain.id] ?? String(chain.id);
}

export function getEvmRpcUrls(chain: Chain, config: RpcConfig): readonly string[] {
  const urls = getEffectiveRpcUrls(getEvmRpcKey(chain), config);
  return urls.length ? urls : chain.rpcUrls.default.http;
}

export function createWagmiConfig(
  chains: readonly Chain[] = walletChains,
  rpcConfig: RpcConfig = {},
) {
  const chainList = (chains.length ? chains : walletChains) as [Chain, ...Chain[]];

  const transports = Object.fromEntries(
    chainList.map((chain) => {
      const urls = getEvmRpcUrls(chain, rpcConfig);
      const httpTransports = urls.map((url) => http(url));
      const transport =
        httpTransports.length > 1
          ? fallback(httpTransports)
          : httpTransports[0] ?? http();
      return [chain.id, transport];
    }),
  ) as Record<number, ReturnType<typeof http>>;

  return createConfig({
    chains: chainList,
    connectors: [injected()],
    multiInjectedProviderDiscovery: true,
    ssr: false,
    transports,
  });
}

export const wagmiConfig = createWagmiConfig(walletChains);
