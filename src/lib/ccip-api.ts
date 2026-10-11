import { viemChainById } from "./viem-chains-by-id";
import type { BridgeChain, BridgeToken } from "./bridge-types";
import { bridgeTokenKey, ccipFeeQuery, normalizeCcipQuote, resolveCcipQuote, type CcipCatalog, type CcipChain, type CcipQuoteRequest } from "./ccip";

const DIRECTORY = "https://docs.chain.link/api/ccip/v1";
const TRANSPORTER = "https://app.transporter.io/api/h";
const TTL = 5 * 60_000;

function cached<T>(load: () => Promise<T>) {
  let entry: { value: T; expires: number } | undefined;
  let pending: Promise<T> | undefined;
  return async () => {
    if (entry && entry.expires > Date.now()) return entry.value;
    if (!pending) pending = load().then(value => {
      entry = { value, expires: Date.now() + TTL };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

async function fetchJson(url: string) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`CCIP service unavailable (${response.status}). Try again shortly.`);
  return response.json() as Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CCIP directory response.");
  return value as Record<string, unknown>;
}

const getBaseChains = cached(async () => {
  const data = record(await fetchJson("https://transfer.layerzero-api.com/v1/chains"));
  if (!Array.isArray(data.chains)) throw new Error("Invalid chain catalog.");
  return data.chains as BridgeChain[];
});

// Transporter points to this public CCIP directory for its networks and tokens.
// Keep the directory dependency here so an API-version migration is isolated.
export function normalizeCcipCatalog(chainResponse: unknown, tokenResponse: unknown, baseChains: BridgeChain[]): CcipCatalog {
  const chainData = record(record(chainResponse).data);
  const tokenData = record(record(tokenResponse).data);
  const chains: CcipChain[] = [];
  const chainByDirectoryId = new Map<string, CcipChain>();
  for (const [family, rawChains] of Object.entries(chainData)) {
    for (const [directoryId, rawChain] of Object.entries(record(rawChains))) {
      const chain = record(rawChain);
      if (chain.supported !== true || typeof chain.internalId !== "string" || typeof chain.router !== "string") continue;
      const chainType = family.toUpperCase();
      const existing = baseChains.find(base => base.chainType === chainType && (family !== "evm" || base.chainId === chain.chainId));
      const viemChain = family === "evm" && typeof chain.chainId === "number" ? viemChainById[chain.chainId] : undefined;
      // Unknown families cannot be safely represented with an EVM numeric chain ID.
      if (!existing && (!viemChain || viemChain.testnet)) continue;
      const chainKey = existing?.chainKey ?? `ccip-${chain.internalId}`;
      const normalized: CcipChain = {
        ...(existing ?? {
          chainKey, chainType, chainId: viemChain!.id,
          name: String(chain.displayName), shortName: String(chain.displayName),
          nativeCurrency: { ...viemChain!.nativeCurrency, chainKey, address: "0x0000000000000000000000000000000000000000" },
        }),
        ccip: { selectorName: chain.internalId, router: chain.router },
      };
      chains.push(normalized);
      chainByDirectoryId.set(directoryId, normalized);
    }
  }
  const tokens = new Map<string, BridgeToken>();
  for (const rawGroup of Object.values(tokenData)) {
    const group = record(rawGroup);
    for (const [directoryId, rawToken] of Object.entries(group)) {
      const chain = chainByDirectoryId.get(directoryId);
      if (!chain) continue;
      const token = record(rawToken);
      if (typeof token.tokenAddress !== "string" || typeof token.symbol !== "string" || typeof token.name !== "string" ||
          typeof token.decimals !== "number" || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36 || !Array.isArray(token.destinations)) continue;
      const destinations = token.destinations.flatMap(id => {
        const destChain = chainByDirectoryId.get(String(id));
        const destToken = group[String(id)];
        if (!destChain || !destToken || destChain.chainKey === chain.chainKey) return [];
        const address = record(destToken).tokenAddress;
        return typeof address === "string" ? [{ chainKey: destChain.chainKey, address }] : [];
      });
      const normalized: BridgeToken = {
        chainKey: chain.chainKey, address: token.tokenAddress, decimals: token.decimals,
        symbol: token.symbol, name: token.name, isSupported: true, isBridgeable: true,
        bridgeProviders: ["ccip"], ccip: { destinations },
      };
      const key = bridgeTokenKey(normalized);
      const previous = tokens.get(key);
      if (previous?.ccip) normalized.ccip!.destinations = [...new Map([...previous.ccip.destinations, ...destinations].map(dest => [bridgeTokenKey(dest), dest])).values()];
      tokens.set(key, normalized);
    }
  }
  if (!chains.length || !tokens.size) throw new Error("CCIP directory is empty or unavailable.");
  return { chains, tokens: [...tokens.values()] };
}

export const getCcipCatalog = cached(async () => {
  const [chains, tokens, baseChains] = await Promise.all([
    fetchJson(`${DIRECTORY}/chains?environment=mainnet`),
    fetchJson(`${DIRECTORY}/tokens?environment=mainnet`),
    getBaseChains(),
  ]);
  return normalizeCcipCatalog(chains, tokens, baseChains);
});

export class CcipRequestError extends Error {}

export async function getCcipQuote(body: unknown) {
  const raw = record(body);
  const fields = ["srcChainKey", "dstChainKey", "srcTokenAddress", "dstTokenAddress", "dstWalletAddress", "amount"] as const;
  if (fields.some(key => typeof raw[key] !== "string" || !raw[key] || (raw[key] as string).length > 256)) {
    throw new CcipRequestError("Select a CCIP token pair, amount and destination address.");
  }
  const request = Object.fromEntries(fields.map(key => [key, raw[key]])) as unknown as CcipQuoteRequest;
  const catalog = await getCcipCatalog();
  let query: URLSearchParams;
  try { query = ccipFeeQuery(catalog, request); }
  catch (error) { throw new CcipRequestError(error instanceof Error ? error.message : "Invalid CCIP quote request."); }
  const { srcChain, dstChain, srcToken } = resolveCcipQuote(catalog, request);
  const latencyQuery = new URLSearchParams({ sourceChainSelectorName: srcChain.ccip.selectorName, destChainSelectorName: dstChain.ccip.selectorName, sourceTokenAddress: srcToken.address });
  const [fees, latency] = await Promise.all([
    fetchJson(`${TRANSPORTER}/transporterData/getTotalFeesEstimate?${query}`),
    fetchJson(`${TRANSPORTER}/ccipData/getLaneLatency?${latencyQuery}`).catch(() => null),
  ]);
  // A missing latency estimate must never prevent a valid fee quote.
  const estimate = latency && typeof latency === "object" && "totalMs" in latency && typeof latency.totalMs === "number" ? latency.totalMs : undefined;
  return normalizeCcipQuote(catalog, request, fees, estimate);
}
