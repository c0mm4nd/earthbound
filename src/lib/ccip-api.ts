import { viemChainById } from "./viem-chains-by-id";
import type { BridgeChain, BridgeToken } from "./bridge-types";
import { bridgeTokenKey, ccipFeeQuery, normalizeCcipQuote, resolveCcipQuote, type CcipCatalog, type CcipChain, type CcipQuoteRequest } from "./ccip";
import { mergeTransporterCatalog, parseTransporterConfig } from "./transporter-catalog";
import { ccipMessageEncoding, ccipNativeFeeToken } from "./ccip-message";
import { APTOS_MAINNET_API } from "./ccip-aptos";

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

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(20_000) });
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
      const nonEvm = ({ solana: { chainId: 0, symbol: "SOL", decimals: 9, address: "11111111111111111111111111111111" },
        aptos: { chainId: 1, symbol: "APT", decimals: 8, address: "0xa" },
        canton: { chainId: 0, symbol: "CC", decimals: 10, address: "CC" },
      } as Record<string, { chainId: number; symbol: string; decimals: number; address: string }>)[family];
      if (!existing && !nonEvm && (!viemChain || viemChain.testnet)) continue;
      const chainKey = existing?.chainKey ?? `ccip-${chain.internalId}`;
      const normalized: CcipChain = {
        ...(existing ?? {
          chainKey, chainType, chainId: nonEvm?.chainId ?? viemChain!.id,
          name: String(chain.displayName), shortName: String(chain.displayName),
          nativeCurrency: nonEvm ? { ...nonEvm, name: nonEvm.symbol, chainKey } : { ...viemChain!.nativeCurrency, chainKey, address: "0x0000000000000000000000000000000000000000" },
        }),
        ccip: { selectorName: chain.internalId, router: chain.router, selector: typeof chain.selector === "string" ? chain.selector : undefined },
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
  const [directory, transporter, baseChains] = await Promise.all([
    Promise.all([fetchJson(`${DIRECTORY}/chains?environment=mainnet`), fetchJson(`${DIRECTORY}/tokens?environment=mainnet`)]).catch(() => null),
    fetch("https://app.transporter.io/", { cache: "no-store", signal: AbortSignal.timeout(12_000) }).then(async response => {
      if (!response.ok) throw new Error("Transporter unavailable.");
      return parseTransporterConfig(await response.text());
    }).catch(() => null),
    getBaseChains().catch(() => [] as BridgeChain[]),
  ]);
  let catalog: CcipCatalog = { chains: [], tokens: [], warnings: [] };
  if (directory) {
    try { catalog = normalizeCcipCatalog(directory[0], directory[1], baseChains); }
    catch { catalog.warnings = ["Some CCIP directory assets are temporarily unavailable."]; }
  } else catalog.warnings = ["Some CCIP directory assets are temporarily unavailable."];
  if (transporter) {
    try { catalog = mergeTransporterCatalog(catalog, transporter, baseChains); }
    catch { catalog.warnings = [...(catalog.warnings ?? []), "Transporter's additional assets are temporarily unavailable."]; }
  } else catalog.warnings = [...(catalog.warnings ?? []), "Transporter's additional assets are temporarily unavailable."];
  if (!catalog.tokens.length) throw new Error("CCIP token catalogs are temporarily unavailable.");
  return catalog;
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
  if (srcChain.chainType === "CANTON" || dstChain.chainType === "CANTON") {
    throw new CcipRequestError("Canton transfers are in development and are not available yet.");
  }
  const latencyQuery = new URLSearchParams({ sourceChainSelectorName: srcChain.ccip.selectorName, destChainSelectorName: dstChain.ccip.selectorName, sourceTokenAddress: srcToken.address });
  const [fees, latency] = await Promise.all([
    srcChain.chainType === "EVM"
      ? fetchJson(`${TRANSPORTER}/transporterData/getTotalFeesEstimate?${query}`)
      : getNonEvmFees(srcChain, dstChain, request),
    fetchJson(`${TRANSPORTER}/ccipData/getLaneLatency?${latencyQuery}`).catch(() => null),
  ]);
  // A missing latency estimate must never prevent a valid fee quote.
  const estimate = latency && typeof latency === "object" && "totalMs" in latency && typeof latency.totalMs === "number" ? latency.totalMs : undefined;
  return normalizeCcipQuote(catalog, request, fees, estimate);
}

async function getNonEvmFees(src: CcipChain, dst: CcipChain, request: CcipQuoteRequest) {
  const message = { ...ccipMessageEncoding(src.chainType, dst.chainType, request.dstWalletAddress), data: "0x",
    tokenAmounts: [{ token: request.srcTokenAddress, amount: request.amount }], feeToken: ccipNativeFeeToken(src.chainType) };
  let fee: unknown;
  if (src.chainType === "APTOS") {
    // The public Transporter adapter currently fails Aptos getFeeData. The router
    // exposes the same quote as an HTTP View API, without token-pool discovery.
    const result = await postJson(`${APTOS_MAINNET_API}/view`, {
      function: `${src.ccip.router}::router::get_fee`, type_arguments: [],
      arguments: [dst.ccip.selector, message.receiver, "0x", [request.srcTokenAddress], [request.amount], ["0x0"], "0xa", "0x0", message.extraArgs],
    });
    fee = Array.isArray(result) ? result[0] : undefined;
  } else {
    fee = await postJson(`${TRANSPORTER}/ccipData/getFeeData`, {
      sourceChainSelectorName: src.ccip.selectorName, destChainSelectorName: dst.ccip.selectorName,
      routerAddress: src.ccip.router, ccipMessage: message,
    });
  }
  if (typeof fee !== "string" || !/^\d+$/.test(fee)) throw new Error("Invalid CCIP fee response.");
  return { ccipFee: fee };
}
