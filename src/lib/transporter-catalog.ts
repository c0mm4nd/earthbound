import type { BridgeChain, BridgeToken } from "./bridge-types";
import { bridgeTokenKey, type CcipCatalog, type CcipChain } from "./ccip";
import { TRANSPORTER_NETWORKS } from "./transporter-networks";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Transporter's curated token list is serialized into its server-rendered page.
// Decode JSON data only. Never evaluate page scripts or bundle code.
export function parseTransporterConfig(html: string): Record<string, unknown> {
  if (html.length > 5_000_000) throw new Error("Transporter catalog response is too large.");
  const chunks: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try {
      const frame: unknown = JSON.parse(match[1]);
      if (Array.isArray(frame) && frame[0] === 1 && typeof frame[1] === "string") chunks.push(frame[1]);
    } catch { /* Ignore non-data frames. */ }
  }
  for (const line of chunks.join("").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    try {
      const frame: unknown = JSON.parse(line.slice(separator + 1));
      if (Array.isArray(frame) && object(frame[3]) && object(frame[3].initialConfig)) return frame[3].initialConfig;
    } catch { /* Flight also includes module and text records. */ }
  }
  throw new Error("Transporter token catalog format changed.");
}

export function mergeTransporterCatalog(directory: CcipCatalog, config: Record<string, unknown>, baseChains: BridgeChain[]): CcipCatalog {
  const chains = new Map(directory.chains.map(chain => [chain.ccip.selectorName, chain]));
  const byNetwork = new Map<string, CcipChain>();
  for (const [key, network] of Object.entries(TRANSPORTER_NETWORKS)) {
    let chain = chains.get(network.selectorName);
    if (!chain) {
      const existing = baseChains.find(base => base.chainType === network.chainType && base.chainId === network.chainId);
      const chainKey = existing?.chainKey ?? `ccip-${network.selectorName}`;
      chain = {
        ...(existing ?? {
          chainKey, chainId: network.chainId, chainType: network.chainType,
          name: key === "mainnet" ? "Ethereum" : key[0].toUpperCase() + key.slice(1),
          shortName: key === "mainnet" ? "Ethereum" : key[0].toUpperCase() + key.slice(1),
          nativeCurrency: { ...network.nativeCurrency, chainKey, address: network.chainType === "EVM" ? "0x0000000000000000000000000000000000000000" : "native" },
        }),
        ccip: { selectorName: network.selectorName, router: network.router, selector: network.selector },
      };
      chains.set(network.selectorName, chain);
    }
    if (!chain.ccip.selector && network.selector) {
      chain = { ...chain, ccip: { ...chain.ccip, selector: network.selector } };
      chains.set(network.selectorName, chain);
    }
    byNetwork.set(key, chain);
  }
  const tokens = new Map(directory.tokens.map(token => [bridgeTokenKey(token), token]));
  let parsed = 0;
  let unknownNetwork = false;
  for (const rawGroup of Object.values(config)) {
    if (!object(rawGroup) || !object(rawGroup.metadata) || !object(rawGroup.networks)) continue;
    const { metadata, networks } = rawGroup;
    if (typeof metadata.name !== "string" || typeof metadata.symbol !== "string") continue;
    for (const [network, rawDeployment] of Object.entries(networks)) {
      const chain = byNetwork.get(network);
      if (!chain) unknownNetwork = true;
      if (!chain || !object(rawDeployment) || !object(rawDeployment.token)) continue;
      const rawToken = rawDeployment.token;
      if (typeof rawToken.address !== "string" || typeof rawToken.decimals !== "number" || !Number.isInteger(rawToken.decimals) || rawToken.decimals < 0 || rawToken.decimals > 36 || !Array.isArray(rawDeployment.destinationNetworks)) continue;
      const destinations = rawDeployment.destinationNetworks.flatMap(destination => {
        if (typeof destination !== "string") return [];
        const dstChain = byNetwork.get(destination);
        const deployment = networks[destination];
        if (!dstChain || dstChain.chainKey === chain.chainKey || !object(deployment) || !object(deployment.token) || typeof deployment.token.address !== "string") return [];
        return [{ chainKey: dstChain.chainKey, address: deployment.token.address }];
      });
      const token: BridgeToken = {
        chainKey: chain.chainKey, address: rawToken.address, decimals: rawToken.decimals,
        name: metadata.name.replace(/^\$\$/, "$"), symbol: metadata.symbol.replace(/^\$\$/, "$"),
        icon: typeof metadata.imageUrl === "string" && metadata.imageUrl.startsWith("https://") ? metadata.imageUrl : undefined,
        isSupported: true, isBridgeable: true, bridgeProviders: ["ccip"], ccip: { destinations },
      };
      const key = bridgeTokenKey(token);
      const previous = tokens.get(key);
      if (previous && previous.decimals !== token.decimals) continue;
      token.ccip!.destinations = [...new Map([...(previous?.ccip?.destinations ?? []), ...destinations].map(dest => [bridgeTokenKey(dest), dest])).values()];
      tokens.set(key, { ...previous, ...token });
      parsed++;
    }
  }
  if (!parsed) throw new Error("Transporter token catalog is empty or unavailable.");
  return {
    chains: [...chains.values()], tokens: [...tokens.values()],
    warnings: [...(directory.warnings ?? []), ...(unknownNetwork ? ["Some new Transporter networks are not supported yet."] : [])],
  };
}
