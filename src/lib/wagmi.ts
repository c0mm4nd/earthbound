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
import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { type RpcConfig, getEffectiveRpcUrls } from "./rpc-config";

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
  scroll,
  somnia,
  soneium,
  unichain,
  worldchain,
  zircuit,
] as const;

export type WalletChainKey = keyof typeof walletChainByKey;
export type SupportedChainId = (typeof walletChains)[number]["id"];

export function createWagmiConfig(rpcConfig: RpcConfig = {}) {
  const chainKeyById = Object.fromEntries(
    Object.entries(walletChainByKey).map(([key, chain]) => [chain.id, key]),
  );

  const transports = Object.fromEntries(
    walletChains.map((chain) => {
      const chainKey = chainKeyById[chain.id];
      const urls = chainKey ? getEffectiveRpcUrls(chainKey, rpcConfig) : [];
      const httpTransports = urls.map((url) => http(url));
      const transport =
        httpTransports.length > 1
          ? fallback(httpTransports)
          : httpTransports[0] ?? http();
      return [chain.id, transport];
    }),
  ) as Record<SupportedChainId, ReturnType<typeof http>>;

  return createConfig({
    chains: walletChains,
    connectors: [injected()],
    ssr: false,
    transports,
  });
}

export const wagmiConfig = createWagmiConfig();
