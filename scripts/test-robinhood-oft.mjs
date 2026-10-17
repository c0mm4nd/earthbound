import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getPublicClient } from "wagmi/actions";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";

const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.require = id => id.startsWith("./") ? load(id.slice(2)) : require(id);
  compiled._compile(outputText, filename);
  cache.set(name, compiled.exports);
  return compiled.exports;
}

const { createWagmiConfig, walletChainByKey } = load("wagmi");
const { viemChainById } = load("viem-chains-by-id");
const { getLayerZeroV2EndpointId } = load("custom-oft");
const config = createWagmiConfig();
const client = getPublicClient(config, { chainId: 4663 });
assert.equal(client.chain.id, 4663);
assert.equal(client.transport.url, "https://rpc.mainnet.chain.robinhood.com");
assert.equal(viemChainById[4663].id, walletChainByKey.robinhood.id);
assert.equal(getLayerZeroV2EndpointId("robinhood"), 30416);
const override = createWagmiConfig(undefined, { robinhood: ["https://rpc.example.com"] });
assert.equal(getPublicClient(override, { chainId: 4663 }).transport.url, "https://rpc.example.com");
console.log("Robinhood: wallet client, chain registry, LayerZero endpoint and RPC overrides passed.");

// Opt-in public contract reads only: no wallet, signature or broadcast.
if (process.env.LIVE_ROBINHOOD_OFT === "1") {
  const { buildDirectOftQuote } = load("direct-oft");
  const nativeCurrency = { symbol: "ETH", decimals: 18 };
  const ethereum = { chainKey: "ethereum", chainId: 1, chainType: "EVM", nativeCurrency };
  const robinhood = { ...ethereum, chainKey: "robinhood", chainId: 4663 };
  const ethToken = { chainKey: "ethereum", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", decimals: 18, symbol: "USDe" };
  const rhToken = { ...ethToken, chainKey: "robinhood", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34" };
  const amount = parseUnits(process.env.ROBINHOOD_OFT_AMOUNT ?? "100", 18);
  const debit = amount / 10n ** 12n * 10n ** 12n;
  assert.equal(await client.getChainId(), 4663);
  for (const reverse of [false, true]) {
    const quote = await buildDirectOftQuote({
      metadata: {}, discoverPeers: true,
      srcChain: reverse ? ethereum : robinhood, dstChain: reverse ? robinhood : ethereum,
      srcToken: reverse ? ethToken : rhToken, dstToken: reverse ? rhToken : ethToken,
      amount,
      from: "0x0000000000000000000000000000000000000005",
      to: "0x0000000000000000000000000000000000000006",
      read: ({ chain, ...params }) => getPublicClient(config, { chainId: chain.chainId }).readContract(params),
    });
    assert.equal(quote.dstAmount, String(debit));
    if (reverse) {
      const approval = quote.userSteps.find(step => step.description === "Approve OFT");
      assert.ok(approval, "the dummy Ethereum sender requires USDe approval");
      assert.equal(decodeFunctionData({ abi: erc20Abi, data: approval.transaction.encoded.data }).args[1], debit);
    }
    console.log(reverse ? "Ethereum → Robinhood" : "Robinhood → Ethereum", JSON.stringify({
      srcAmount: quote.srcAmount, dstAmount: quote.dstAmount, fees: quote.fees,
      target: quote.userSteps.at(-1).transaction.encoded.to,
    }));
  }
}
