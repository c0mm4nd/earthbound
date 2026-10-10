export type RpcConfig = Record<string, string[]>;

// Public RPC defaults. Solana's official public endpoint rejects browser-origin
// requests with 403, so use the PublicNode endpoint verified from the deployed app.
export const DEFAULT_RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://eth.drpc.org"],
  arbitrum: ["https://arbitrum.drpc.org"],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
  optimism: ["https://optimism.drpc.org"],
  bsc: ["https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"],
  avalanche: ["https://avalanche.drpc.org"],
  polygon: ["https://polygon.drpc.org"],
  linea: ["https://linea.drpc.org"],
  scroll: ["https://scroll.drpc.org"],
  manta: ["https://manta-pacific.drpc.org"],
  metis: ["https://metis.drpc.org"],
  unichain: ["https://unichain.drpc.org"],
  abstract: ["https://abstract.drpc.org"],
  hemi: ["https://hemi.drpc.org"],
  hyperliquid: ["https://hyperliquid.drpc.org", "https://rpc.hyperliquid.xyz/evm"],
  plasma: ["https://rpc.plasma.to"],
  somnia: ["https://api.infra.mainnet.somnia.network"],
  soneium: ["https://soneium.drpc.org"],
  worldchain: ["https://worldchain.drpc.org"],
  zircuit: ["https://mainnet.zircuit.com"],
  solana: ["https://solana-rpc.publicnode.com"],
  sui: ["https://fullnode.mainnet.sui.io:443"],
  iota: ["https://api.mainnet.iota.cafe"],
};

const STORAGE_KEY = "earthbound.rpc_config.v1";

function withoutLlamaRpc(urls: string[]): string[] {
  return urls.filter((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host !== "llamarpc.com" && !host.endsWith(".llamarpc.com");
    } catch {
      return false;
    }
  });
}

export function loadRpcConfig(): RpcConfig {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!Array.isArray(value)) return [];
      const urls = withoutLlamaRpc(value.filter((url): url is string => typeof url === "string"));
      return urls.length ? [[key, urls]] : [];
    }));
  } catch {
    return {};
  }
}

export function saveRpcConfig(config: RpcConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function getEffectiveRpcUrls(chainKey: string, userConfig: RpcConfig): string[] {
  const user = withoutLlamaRpc(userConfig[chainKey] ?? []);
  if (user && user.length > 0) return user;
  return DEFAULT_RPC_URLS[chainKey] ?? [];
}
