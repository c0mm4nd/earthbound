import type { BridgeToken } from "./bridge-types";
import { BRIDGE_NETWORK_ICONS } from "./bridge-icon-networks";

const LEGACY_ICONS = "https://icons-ckg.pages.dev/stargate-light";
export const PROTOCOL_ICONS = { ccip: "/icons/protocols/ccip.svg", cctp: "/icons/protocols/cctp.svg" } as const;

/** Only local artwork or HTTPS metadata; never interpret token metadata as markup. */
export function safeIconUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^\/icons\/[a-z0-9/_-]+\.svg$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Missing/invalid metadata falls back to the symbol or initials. */ }
  return undefined;
}
export function getTokenSymbolIconUrl(symbol?: string) {
  if (!symbol) return undefined;
  const normalized = symbol === "USDT0.s" ? "USDT0" : symbol;
  if (normalized.toUpperCase() === "USDC") return "/icons/tokens/usdc.svg";
  return `${LEGACY_ICONS}/tokens/${encodeURIComponent(normalized.toLowerCase())}.svg`;
}
export function getTokenIconUrl(token: BridgeToken, displayIcon?: string, symbol = token.symbol) {
  return safeIconUrl(token.icon) ?? safeIconUrl(displayIcon) ?? getTokenSymbolIconUrl(symbol);
}
export function getChainIconUrl(chainKey?: string) {
  if (!chainKey) return undefined;
  const slug = BRIDGE_NETWORK_ICONS[chainKey];
  return slug ? `/icons/networks/${slug}.svg` : `${LEGACY_ICONS}/networks/${encodeURIComponent(chainKey)}.svg`;
}
export function getAssetIconFallback(src: string | undefined, label: string) {
  // Metadata token images get a second chance through the symbol catalog.
  // Local/network icons already have an explicit mapping, so fall back to initials.
  return src?.startsWith("https://") && !src.startsWith(LEGACY_ICONS + "/") ? getTokenSymbolIconUrl(label) : undefined;
}
