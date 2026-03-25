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
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

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

const transports = Object.fromEntries(
  walletChains.map((chain) => [chain.id, http()]),
) as Record<SupportedChainId, ReturnType<typeof http>>;

export const wagmiConfig = createConfig({
  chains: walletChains,
  connectors: [injected()],
  ssr: false,
  transports,
});
