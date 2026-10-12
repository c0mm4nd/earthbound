import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const modules = new Map();
const requests = [];
let failFees = false;
let failLatency = false;
let failDirectory = false;
let failBaseCatalog = false;
const address = n => `0x${n.toString(16).padStart(40, "0")}`;
const native = { chainKey: "ethereum", address: address(0), decimals: 18, symbol: "ETH", name: "Ether" };
const baseChains = [
  { chainKey: "ethereum", chainId: 1, chainType: "EVM", name: "Ethereum", shortName: "Ethereum", nativeCurrency: native },
  { chainKey: "base", chainId: 8453, chainType: "EVM", name: "Base", shortName: "Base", nativeCurrency: { ...native, chainKey: "base" } },
  { chainKey: "solana", chainId: 1, chainType: "SOLANA", name: "Solana", shortName: "Solana", nativeCurrency: { ...native, symbol: "SOL", decimals: 9 } },
];
const chains = { data: {
  evm: {
    1: { chainId: 1, displayName: "Ethereum", internalId: "ethereum-mainnet", selector: "5009297550715157269", router: address(10), supported: true },
    8453: { chainId: 8453, displayName: "Base", internalId: "ethereum-mainnet-base-1", selector: "15971525489660198786", router: address(11), supported: true },
  },
  solana: { solana: { chainId: "solana", displayName: "Solana", internalId: "solana-mainnet", router: "router", supported: true } },
} };
const tokens = { data: {
  TEST: {
    1: { tokenAddress: address(1), decimals: 18, symbol: "TEST", name: "Test", destinations: ["8453", "solana"] },
    8453: { tokenAddress: address(2), decimals: 6, symbol: "TEST", name: "Test", destinations: [] },
    solana: { tokenAddress: "AbCd", decimals: 9, symbol: "TEST", name: "Test", destinations: ["1"] },
  },
  SAME_SYMBOL_DIFFERENT_TOKEN: {
    1: { tokenAddress: address(3), decimals: 18, symbol: "TEST", name: "Different token", destinations: ["8453"] },
    8453: { tokenAddress: address(4), decimals: 18, symbol: "TEST", name: "Different token", destinations: ["1"] },
  },
} };
const transporterConfig = {
  "transporter-only": { metadata: { symbol: "$$TEST", name: "Transporter test", imageUrl: "https://example.test/token.svg" }, networks: {
    mainnet: { token: { address: address(6), decimals: 18 }, destinationNetworks: ["base"] },
    base: { token: { address: address(7), decimals: 6 }, destinationNetworks: [] },
  } },
};
const flight = `24:${JSON.stringify(["$", "$L1", null, { initialConfig: transporterConfig }])}\n`;
const transporterHtml = `<script>self.__next_f.push(${JSON.stringify([1, flight.slice(0, 75)])})</script><script>self.__next_f.push(${JSON.stringify([1, flight.slice(75)])})</script>`;

async function mockFetch(url) {
  requests.push(String(url));
  if (url === "https://app.transporter.io/") return new Response(transporterHtml);
  if (url.includes("transfer.layerzero-api.com")) return failBaseCatalog ? new Response("offline", { status: 503 }) : Response.json({ chains: baseChains });
  if (url.includes("/chains?")) return failDirectory ? new Response("offline", { status: 503 }) : Response.json(chains);
  if (url.includes("/tokens?")) return failDirectory ? new Response("offline", { status: 503 }) : Response.json(tokens);
  if (url.includes("getTotalFeesEstimate")) return failFees ? new Response("Unavailable", { status: 503 }) : Response.json({ ccipFee: "123456789", tokenTransferFee: { feeDeducted: "1000000000000000" } });
  if (url.includes("getLaneLatency")) return failLatency ? new Response("Unavailable", { status: 500 }) : Response.json({ totalMs: 954000 });
  throw new Error(`Unexpected request ${url}`);
}

function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const commonJsModule = { exports: {} };
  new Script(outputText, { filename: `${name}.cjs` }).runInNewContext({
    module: commonJsModule, exports: commonJsModule.exports, URLSearchParams, AbortSignal,
    fetch: mockFetch,
    require: id => id.startsWith("./") ? load(id.slice(2)) : require(id),
  });
  modules.set(name, commonJsModule.exports);
  return commonJsModule.exports;
}

const { normalizeCcipCatalog, getCcipCatalog, getCcipQuote } = load("ccip-api");
const { bridgeTokenKey, ccipTransferKey, mergeBridgeTokens, ccipDestinationTokens, ccipFeeQuery, normalizeCcipQuote, supportsCcipPair } = load("ccip");
const { parseTransporterConfig, mergeTransporterCatalog } = load("transporter-catalog");
const catalog = normalizeCcipCatalog(chains, tokens, baseChains);
const parsedConfig = parseTransporterConfig(transporterHtml);
assert.equal(JSON.stringify(parsedConfig), JSON.stringify(transporterConfig), "Flight chunks are joined before parsing");
assert.throws(() => parseTransporterConfig('<script>self.__next_f.push((()=>{throw Error("executed")})())</script>'), /format changed/, "page code must never execute");
const combined = mergeTransporterCatalog(catalog, parsedConfig, baseChains);
assert.equal(combined.tokens.length, catalog.tokens.length + 2, "include Transporter assets absent from the CCIP directory");
assert.equal(combined.tokens.find(t => t.address === address(6)).symbol, "$TEST", "decode Flight dollar escaping");
assert.equal(combined.tokens.find(t => t.address === address(6)).ccip.destinations[0].chainKey, "base");
assert.equal(combined.chains.find(c => c.chainKey === "ethereum").ccip.router, address(10), "live directory router overrides snapshot");
const source = catalog.tokens.find(t => t.address === address(1));
const dest = catalog.tokens.find(t => t.address === address(2));
assert.ok(dest, "receive-only deployments must remain in the catalog");
assert.equal(catalog.chains.find(c => c.chainKey === "solana").chainType, "SOLANA", "numeric ID 1 must not collide across families");
assert.notEqual(bridgeTokenKey({ chainKey: "solana", address: "AbCd" }), bridgeTokenKey({ chainKey: "solana", address: "abcd" }));
assert.equal(bridgeTokenKey({ chainKey: "base", address: "0xAB" }), bridgeTokenKey({ chainKey: "base", address: "0xab" }));
assert.equal(supportsCcipPair(source, dest), true);
assert.equal(supportsCcipPair(dest, source), false, "routes are directional");
assert.equal(supportsCcipPair(source, catalog.tokens.find(t => t.address === address(4))), false, "same symbols do not imply the same token");
assert.equal(ccipDestinationTokens(catalog, "ethereum", address(1)).length, 2);
const merged = mergeBridgeTokens([{ ...source, price: { usd: 2 }, icon: "icon.svg" }], catalog.tokens);
assert.equal(merged.length, catalog.tokens.length, "duplicate deployments are merged");
assert.equal(merged.find(t => t.address === address(1)).bridgeProviders.join(","), "layerzero,ccip");
assert.equal(merged.find(t => t.address === address(1)).price.usd, 2);
assert.equal(merged.find(t => t.address === address(1)).icon, "icon.svg");

const request = { srcChainKey: "ethereum", dstChainKey: "base", srcTokenAddress: address(1), dstTokenAddress: address(2), dstWalletAddress: address(9), amount: "1234567890123456789" };
assert.equal(ccipTransferKey(request, address(9)), ccipTransferKey({ ...request, amount: "0" + request.amount, srcTokenAddress: request.srcTokenAddress.toUpperCase() }, address(9).toUpperCase()), "same transfer is identified independently of amount padding and address case");
assert.equal(ccipFeeQuery(catalog, request).get("amount"), "1.234567890123456789", "API accepts human units without float conversion");
const quote = normalizeCcipQuote(catalog, request, { ccipFee: "123", tokenTransferFee: { feeDeducted: "1000000000000000" } }, 954000).quotes[0];
assert.equal(quote.dstAmount, "1233567", "subtract transfer fee before flooring to destination precision");
assert.equal(quote.fees[0].symbol, "ETH");
assert.equal(quote.fees[1].amount, "1000000000000000");
assert.equal(quote.feeUsd, undefined, "unknown USD fee is never treated as zero");
assert.equal(quote.ccip.sourceSelector, "5009297550715157269");
assert.equal(quote.ccip.maxNativeFee, "125");
assert.equal(quote.fees[0].amount, "125");
assert.equal(quote.userSteps.length, 0);
assert.equal(quote.dstAmountMin, undefined, "CCIP does not enforce a receive minimum on-chain");
assert.equal(quote.duration.estimated, "954000");
for (const amount of ["0", "-1", "1.2", "1e18", "9".repeat(79)]) assert.throws(() => ccipFeeQuery(catalog, { ...request, amount }));
assert.throws(() => ccipFeeQuery(catalog, { ...request, dstWalletAddress: address(0) }), /destination address/);
assert.throws(() => ccipFeeQuery(catalog, { ...request, dstTokenAddress: address(4) }), /pair/);
assert.throws(() => ccipFeeQuery(catalog, { ...request, dstChainKey: "solana", dstTokenAddress: "AbCd" }), /destination address/);
for (const data of [{}, { ccipFee: "-1" }, { ccipFee: 1 }, { ccipFee: "1", tokenTransferFee: { feeDeducted: request.amount } }, { ccipFee: "1", tokenTransferFee: "bad" }]) assert.throws(() => normalizeCcipQuote(catalog, request, data));
assert.throws(() => normalizeCcipQuote(catalog, { ...request, amount: "1" }, { ccipFee: "1" }), /too small/);

await Promise.all([getCcipCatalog(), getCcipCatalog(), getCcipCatalog()]);
assert.equal(requests.filter(url => url.includes("/tokens?")).length, 1, "deduplicate concurrent catalog fetches");
await getCcipQuote(request);
await getCcipQuote({ ...request, amount: "2000000000000000000" });
assert.equal(requests.filter(url => url.includes("getTotalFeesEstimate")).length, 2, "fee estimates must not be cached");
failLatency = true;
assert.equal((await getCcipQuote(request)).quotes[0].duration, undefined, "latency failure does not discard fee quotes");
failFees = true;
await assert.rejects(getCcipQuote(request), /503/);
await assert.rejects(getCcipQuote({ ...request, amount: undefined }), /Select a CCIP/);
modules.clear();
failDirectory = true;
failBaseCatalog = true;
const standalone = await load("ccip-api").getCcipCatalog();
assert.equal(standalone.tokens.length, 2, "Transporter catalog remains available during directory and LayerZero outages");
assert.ok(standalone.warnings.length);

let baseAvailable = true;
let ccipAvailable = true;
let baseCalls = 0;
function loadRoute(name) {
  const source = readFileSync(new URL(`../src/app/api/bridge/${name}/route.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const commonJsModule = { exports: {} };
  new Script(outputText).runInNewContext({
    module: commonJsModule, exports: commonJsModule.exports, URL,
    require: id => {
      if (id === "next/server") return { NextResponse: { json: (...args) => Response.json(...args) } };
      if (id === "@/lib/ccip") return load("ccip");
      if (id === "@/lib/ccip-status") return load("ccip-status");
      if (id === "@/lib/cctp-bridge") return { mergeCctpTokens: tokens => tokens, cctpBridgeChains: () => [] };
      if (id === "@/lib/ccip-api") return { getCcipCatalog: async () => { if (!ccipAvailable) throw new Error("offline"); return catalog; } };
      if (id === "@/lib/layerzero") return { fetchLayerZeroJson: async () => {
        baseCalls++;
        if (!baseAvailable) throw new Error("offline");
        return { response: { ok: true }, data: { chains: baseChains, tokens: [sourceToken] } };
      } };
      if (id === "@/lib/bridge-normalization") return {};
      return require(id);
    },
  });
  return commonJsModule.exports;
}
const sourceToken = { ...source, bridgeProviders: undefined };
const tokenRoute = loadRoute("tokens");
const chainRoute = loadRoute("chains");
let response = await tokenRoute.GET(new Request("https://earthbound.test/api/bridge/tokens"));
assert.equal((await response.json()).tokens.length, catalog.tokens.length);
ccipAvailable = false;
response = await tokenRoute.GET(new Request("https://earthbound.test/api/bridge/tokens"));
let result = await response.json();
assert.equal(response.status, 200);
assert.equal(result.tokens.length, 1, "CCIP outage retains base tokens");
assert.match(result.warnings[0], /CCIP/);
baseAvailable = false;
response = await chainRoute.GET(new Request("https://earthbound.test/api/bridge/chains"));
assert.equal(response.status, 500, "total outage must not be cached as an empty catalog");
ccipAvailable = true;
response = await tokenRoute.GET(new Request(`https://earthbound.test/api/bridge/tokens?transferrableFromChainKey=ethereum&transferrableFromTokenAddress=${address(1)}`));
result = await response.json();
assert.equal(result.tokens.length, 2, "CCIP destinations survive a base route request failure");
assert.ok(result.tokens.every(token => token.chainKey !== "ethereum"));
response = await tokenRoute.GET(new Request("https://earthbound.test/api/bridge/tokens?transferrableFromChainKey=ethereum"));
assert.equal(response.status, 400);
const callsBeforeGuard = baseCalls;
for (const route of ["build-user-steps", "submit-signature"]) {
  response = await loadRoute(route).POST(new Request(`https://earthbound.test/api/bridge/${route}`, { method: "POST", body: JSON.stringify({ provider: "ccip", quoteId: "ccip:test" }) }));
  assert.equal(response.status, 400);
}
response = await loadRoute("status/[quoteId]").GET(new Request("https://earthbound.test/api/bridge/status/ccip:test?provider=ccip"), { params: Promise.resolve({ quoteId: "ccip:test" }) });
assert.equal(response.status, 400);
assert.equal(baseCalls, callsBeforeGuard, "CCIP requests never fall through to another provider's execution or tracking API");
console.log("CCIP catalog, route validation, fee precision, caching, failure isolation and provider isolation guards passed.");
