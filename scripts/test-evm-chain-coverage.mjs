import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import ts from "typescript";
import { getPublicClient } from "wagmi/actions";

const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const compiled = new Module(filename);
  compiled.require = id => id.startsWith("./") ? load(id.slice(2)) : require(id);
  compiled._compile(outputText, filename);
  cache.set(name, compiled.exports);
  return compiled.exports;
}

const { walletChains, createWagmiConfig, getEvmRpcKey, getEvmRpcUrls } = load("wagmi");
const { mergeEvmChains, viemChainById } = load("viem-chains-by-id");
const { getLayerZeroV2EndpointId } = load("custom-oft");
// Snapshot of /api/bridge/chains on 2026-10-13. LIVE_CHAIN_AUDIT also detects new chains.
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/bridge-evm-chains.json", import.meta.url), "utf8"));
const merged = mergeEvmChains(walletChains, snapshot.map(c => c.chainId));
const config = createWagmiConfig(merged);
for (const { chainKey, chainId, layerzero } of snapshot) {
  const client = getPublicClient(config, { chainId });
  assert.ok(client, `${chainKey}: missing wallet client`);
  assert.equal(client.chain.id, chainId);
  assert.notEqual(client.chain.testnet, true, `${chainKey}: must not select testnet`);
  assert.ok(getEvmRpcUrls(client.chain, {}).length, `${chainKey}: missing RPC`);
  if (layerzero) assert.ok(getLayerZeroV2EndpointId(chainKey), `${chainKey}: missing OFT endpoint`);
}
const duplicated = mergeEvmChains(walletChains, [...snapshot, ...snapshot].map(c => c.chainId));
assert.equal(duplicated.length, merged.length, "Overlapping bridge catalogs must not duplicate wallet chains");
assert.equal(mergeEvmChains(merged, [987654321]).length, merged.length, "Do not invent RPCs for unknown chains");
assert.ok(getPublicClient(createWagmiConfig([]), { chainId: 1 }), "Empty chain list must retain working default transports");
assert.equal(viemChainById[5042].nativeCurrency.decimals, 18, "Arc gas denomination differs from ERC20 USDC");
assert.equal(viemChainById[127001].id, 127001);
assert.equal(viemChainById[1625].id, 1625, "Gravity L1 must not replace Gravity Alpha");
assert.equal(viemChainById[61901].rpcUrls.default.http[0], "https://rpc.movan.movachain.com", "Mova v2 must not use the v1 RPC");

// A real HTTP request proves both static and dynamic settings reach the transport.
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks));
  requests.push(request.url);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: `0x${Number(request.url.slice(1)).toString(16)}` }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const root = `http://127.0.0.1:${server.address().port}`;
  for (const id of [4663, 5064014, 146, 5000, 8822]) {
    const chain = viemChainById[id];
    const key = getEvmRpcKey(chain);
    const customized = createWagmiConfig(merged, { [key]: [`${root}/${id}`] });
    assert.equal(await getPublicClient(customized, { chainId: id }).getChainId(), id);
    assert.equal(requests.at(-1), `/${id}`);
  }
  assert.equal(getEvmRpcKey(viemChainById[8822]), "8822", "IOTA EVM must not use IOTA Move RPC");
  const chain = viemChainById[146];
  const customUrls = [`${root}/146`, `${root}/146-backup`];
  const fallbackClient = getPublicClient(createWagmiConfig(merged, { "146": customUrls }), { chainId: 146 });
  assert.deepEqual(fallbackClient.transport.transports.map(t => t.value.url), customUrls);
  assert.deepEqual(getEvmRpcUrls(chain, { "146": [] }), chain.rpcUrls.default.http);
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log(`EVM coverage: ${snapshot.length} chains, OFT endpoints, deduplication, static/dynamic RPC requests and IOTA isolation passed.`);

// Optional read-only audit: check the current catalog, chain IDs, browser CORS,
// and actual block reads. eth_chainId alone can be a gateway's static response.
if (process.env.LIVE_CHAIN_AUDIT === "1") {
  const response = await fetch(process.env.CHAIN_CATALOG_URL ?? "http://localhost:3000/api/bridge/chains");
  assert.ok(response.ok);
  const catalog = await response.json();
  const only = process.env.CHAIN_AUDIT_IDS?.split(",").map(Number);
  const queue = catalog.chains.filter(c => c.chainType === "EVM" && (!only || only.includes(c.chainId)));
  const liveConfig = createWagmiConfig(mergeEvmChains(walletChains, queue.map(c => c.chainId)));
  const results = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const chain = queue.shift();
      const client = getPublicClient(liveConfig, { chainId: chain.chainId });
      const checks = [];
      if (client) for (const url of getEvmRpcUrls(client.chain, {})) {
        try {
          const rpc = async (method, params) => {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            return { data: data.result, cors: res.headers.get("access-control-allow-origin") };
          };
          const id = await rpc("eth_chainId", []);
          assert.equal(Number(id.data), chain.chainId);
          const block = await rpc("eth_getBlockByNumber", ["latest", false]);
          assert.ok(block.data?.number && block.data?.timestamp, "RPC must serve blocks, not only chain ID");
          assert.ok(["*", "http://localhost:3000"].includes(block.cors), "Browser CORS missing");
          checks.push({ url, ok: true, chainId: Number(id.data), block: Number(block.data.number), blockTime: new Date(Number(block.data.timestamp) * 1000).toISOString(), cors: block.cors });
          break;
        } catch (error) {
          checks.push({ url, ok: false, error: error.message.split("\n")[0] });
        }
      }
      const result = { chainKey: chain.chainKey, chainId: chain.chainId, registered: Boolean(client), checks, ok: checks.some(c => c.ok) };
      results.push(result);
      if (!result.ok) console.log("RPC unavailable:", JSON.stringify(result));
    }
  }));
  const report = { checkedAt: new Date().toISOString(), warnings: catalog.warnings, results: results.sort((a, b) => a.chainId - b.chainId) };
  if (process.env.CHAIN_AUDIT_OUTPUT) writeFileSync(process.env.CHAIN_AUDIT_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`Live RPC audit: ${results.filter(r => r.ok).length}/${results.length} passed; ${results.filter(r => !r.registered).length} unregistered.`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
