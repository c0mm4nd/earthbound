export type RpcConfig = Record<string, string[]>;

export const DEFAULT_RPC_URLS: Record<string, string[]> = {
  ethereum: [
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
  ],
  arbitrum: [
    "https://arb1.arbitrum.io/rpc",
    "https://rpc.ankr.com/arbitrum",
    "https://arbitrum.llamarpc.com",
  ],
  base: [
    "https://mainnet.base.org",
    "https://rpc.ankr.com/base",
    "https://base.llamarpc.com",
  ],
  optimism: [
    "https://mainnet.optimism.io",
    "https://rpc.ankr.com/optimism",
    "https://optimism.llamarpc.com",
  ],
  bsc: [
    "https://bsc-dataseed.binance.org",
    "https://rpc.ankr.com/bsc",
    "https://bsc.llamarpc.com",
  ],
  avalanche: [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://rpc.ankr.com/avalanche",
    "https://avalanche.llamarpc.com",
  ],
  polygon: [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
  ],
  linea: [
    "https://rpc.linea.build",
    "https://linea.llamarpc.com",
    "https://rpc.ankr.com/linea",
  ],
  scroll: [
    "https://rpc.scroll.io",
    "https://rpc.ankr.com/scroll",
  ],
  manta: [
    "https://pacific-rpc.manta.network/http",
  ],
  metis: [
    "https://andromeda.metis.io/?owner=1088",
  ],
  unichain: [
    "https://mainnet.unichain.org",
  ],
  abstract: [
    "https://api.mainnet.abs.xyz",
  ],
  hemi: [
    "https://rpc.hemi.network/rpc",
  ],
  hyperliquid: [
    "https://rpc.hyperliquid.xyz/evm",
  ],
  plasma: [
    "https://rpc.plasma.to",
  ],
  somnia: [
    "https://api.infra.mainnet.somnia.network",
  ],
  soneium: [
    "https://rpc.soneium.org",
    "https://rpc.ankr.com/soneium",
  ],
  worldchain: [
    "https://worldchain-mainnet.g.alchemy.com/public",
    "https://rpc.ankr.com/worldchain",
  ],
  zircuit: [
    "https://mainnet.zircuit.com",
    "https://rpc.ankr.com/zircuit",
  ],
  // Non-EVM chains (only the first URL is used)
  solana: [
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://solana.llamarpc.com",
  ],
  sui: [
    "https://fullnode.mainnet.sui.io:443",
    "https://rpc.ankr.com/sui",
    "https://sui.llamarpc.com",
  ],
  iota: [
    "https://api.mainnet.iota.cafe",
  ],
};

const STORAGE_KEY = "earthbound.rpc_config.v1";

export function loadRpcConfig(): RpcConfig {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as RpcConfig) : {};
  } catch {
    return {};
  }
}

export function saveRpcConfig(config: RpcConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function getEffectiveRpcUrls(chainKey: string, userConfig: RpcConfig): string[] {
  const user = userConfig[chainKey];
  if (user && user.length > 0) return user;
  return DEFAULT_RPC_URLS[chainKey] ?? [];
}
