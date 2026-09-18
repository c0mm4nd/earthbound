import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { createPublicClient, decodeFunctionData, encodeFunctionData, encodeAbiParameters, parseAbiParameters, erc20Abi, http, padHex } from "viem";

const require = createRequire(import.meta.url);
function load(name) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const commonJsModule = { exports: {} };
  new Script(outputText).runInNewContext({ module: commonJsModule, exports: commonJsModule.exports, require: (id) => id === "./custom-oft" ? load("custom-oft") : require(id) });
  return commonJsModule.exports;
}
const { buildDirectOftQuote, hasReceiveGas, extractOftCandidates } = load("direct-oft");
const { buildLayerZeroExecutorLzReceiveOption, layerZeroOftV2Abi } = load("custom-oft");
const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const nativeCurrency = { decimals: 18, symbol: "ETH" };
const srcChain = { chainKey: "ethereum", chainType: "EVM", nativeCurrency };
const dstChain = { chainKey: "arbitrum", chainType: "EVM", nativeCurrency };
const srcToken = { chainKey: "ethereum", address: addr(1), decimals: 18, symbol: "TEST" };
const dstToken = { chainKey: "arbitrum", address: addr(2), decimals: 6, symbol: "TEST" };
const metadata = { TEST: [{ endpointVersion: "v2", deployments: {
  ethereum: { address: addr(3), innerTokenAddress: addr(1) },
  arbitrum: { address: addr(4), innerTokenAddress: addr(2) },
} }] };
const amount = 10n ** 18n;
let allowance = 0n;
let receiveAmount = amount;
let wrongPeer = false;
let configuredOptions = buildLayerZeroExecutorLzReceiveOption(65000n);
const read = async ({ chain, functionName, args }) => {
  const source = chain.chainKey === "ethereum";
  switch (functionName) {
    case "peers": return padHex(wrongPeer ? addr(9) : source ? addr(4) : addr(3), { size: 32 });
    case "token": return source ? addr(1) : addr(2);
    case "sharedDecimals": return 6;
    case "decimals": return source ? 18 : 6;
    case "approvalRequired": return true;
    case "enforcedOptions": return configuredOptions;
    case "allowance": return allowance;
    case "quoteOFT": return [{ minAmountLD: 1n, maxAmountLD: amount * 2n }, [], { amountSentLD: amount, amountReceivedLD: receiveAmount }];
    case "quoteSend":
      assert.equal(args[0].minAmountLD, receiveAmount);
      assert.equal(args[0].extraOptions, "0x");
      return { nativeFee: 100n, lzTokenFee: 0n };
    default: throw new Error(functionName);
  }
};
const args = { metadata, srcChain, dstChain, srcToken, dstToken, amount, from: addr(5), to: addr(6), read };
assert.equal(hasReceiveGas(configuredOptions), true);
assert.equal(hasReceiveGas("0x"), false);
assert.equal(hasReceiveGas("0x00030100110100"), false);
assert.equal(hasReceiveGas(buildLayerZeroExecutorLzReceiveOption(0n)), false);
const quote = await buildDirectOftQuote(args);
assert.equal(quote.dstAmount, "1000000", "source local decimals must convert to destination local decimals");
assert.equal(quote.fees.length, 1, "no Stargate product fee");
assert.equal(quote.userSteps.length, 2);
const send = quote.userSteps.at(-1).transaction.encoded;
assert.equal(send.to, addr(3), "send must target OFT, not an API wrapper");
assert.equal(send.value, "100");
const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: send.data });
assert.equal(decoded.functionName, "send");
assert.equal(decoded.args[0].amountLD, amount, "do not subtract a frontend fee");
assert.equal(decoded.args[0].to, padHex(addr(6), { size: 32 }));
allowance = 1n;
const reset = await buildDirectOftQuote(args);
assert.equal(reset.userSteps.length, 3);
assert.equal(decodeFunctionData({ abi: erc20Abi, data: reset.userSteps[0].transaction.encoded.data }).args[1], 0n);
allowance = amount;
assert.equal((await buildDirectOftQuote(args)).userSteps.length, 1);
receiveAmount = amount - amount / 5000n;
const feeQuote = await buildDirectOftQuote(args);
assert.equal(feeQuote.dstAmount, "999800", "preserve contract-level fees");
assert.equal(feeQuote.fees[1].amount, (amount / 5000n).toString());
wrongPeer = true;
await assert.rejects(buildDirectOftQuote(args), /peers do not match/);
wrongPeer = false;
configuredOptions = "0x";
await assert.rejects(buildDirectOftQuote(args), /receive gas/);
configuredOptions = buildLayerZeroExecutorLzReceiveOption(65000n);
await assert.rejects(buildDirectOftQuote({ ...args, dstToken: { ...dstToken, address: addr(7) } }), /No direct OFT mesh/);
await assert.rejects(buildDirectOftQuote({ ...args, dstChain: { ...dstChain, chainType: "SUI" } }), /EVM/);
assert.equal((await buildDirectOftQuote({ ...args, metadata: { TEST: [...metadata.TEST, ...metadata.TEST] } })).dstAmount, "999800");
const wrongMesh = { ...metadata.TEST[0], deployments: { ...metadata.TEST[0].deployments, ethereum: { address: addr(8), innerTokenAddress: addr(1) } } };
assert.equal((await buildDirectOftQuote({ ...args, metadata: { TEST: [wrongMesh, ...metadata.TEST] } })).userSteps.at(-1).transaction.encoded.to, addr(3));
await assert.rejects(buildDirectOftQuote({ ...args, amount: amount * 3n }), /transfer limits/);
console.log("Direct OFT: amounts, fees, calldata, allowances, peers, gas, and unsupported routes passed.");

// Opt-in mainnet reads only. No wallet, signing, approvals, or sends.
if (process.env.LIVE_OFT_SMOKE === "1") {
  const srcAddress = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const dstAddress = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
  const response = await fetch(`https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?contractAddresses=${srcAddress}&chainNames=ethereum,arbitrum`);
  assert.equal(response.ok, true);
  const clients = {
    ethereum: createPublicClient({ transport: http("https://eth.drpc.org", { timeout: 15000, retryCount: 0 }) }),
    arbitrum: createPublicClient({ transport: http("https://arbitrum.drpc.org", { timeout: 15000, retryCount: 0 }) }),
  };
  const live = await buildDirectOftQuote({
    ...args, metadata: await response.json(),
    srcToken: { ...srcToken, address: srcAddress, decimals: 6, symbol: "USDT" },
    dstToken: { ...dstToken, address: dstAddress, symbol: "USDT0" },
    amount: 1000000n,
    read: ({ chain, ...params }) => clients[chain.chainKey].readContract(params),
  });
  console.log("Mainnet read-only quote:", JSON.stringify({
    srcAmount: live.srcAmount, dstAmount: live.dstAmount, fees: live.fees,
    targets: live.userSteps.map((step) => step.transaction.encoded.to),
  }));
}

// Discovery must resolve adapters by peer and validate both token identities.
const peerRead = async (params) => {
  const expected = params.chain.chainKey === "ethereum" ? addr(3) : addr(4);
  if (["token", "peers"].includes(params.functionName) && params.address.toLowerCase() !== expected)
    throw new Error("Not an OFT");
  return read(params);
};
const sendData = encodeFunctionData({ abi: layerZeroOftV2Abi, functionName: "send", args: [
  { dstEid: 30110, to: padHex(addr(6), { size: 32 }), amountLD: amount, minAmountLD: 1n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" },
  { nativeFee: 100n, lzTokenFee: 0n }, addr(5),
] });
const envelope = `0x571d3dc7${encodeAbiParameters(parseAbiParameters("(address target,uint256 value,bytes callData)[],bytes32"), [
  [{ target: addr(3), value: 100n, callData: sendData }], padHex("0x01", { size: 32 }),
]).slice(2)}`;
const apiHint = { quotes: [{ userSteps: [{ type: "TRANSACTION", chainKey: "ethereum", chainType: "EVM", transaction: { encoded: { to: addr(99), data: envelope } } }] }] };
assert.deepEqual(Array.from(extractOftCandidates(apiHint, srcChain, 30110)), [addr(3)]);
assert.equal(extractOftCandidates(apiHint, srcChain, 30106).length, 0);
assert.equal(extractOftCandidates({ quotes: [] }, srcChain, 30110).length, 0);
let apiCalls = 0;
const discoveryArgs = { ...args, metadata: {}, discoverPeers: true, read: peerRead,
  fetchDiscoveryQuote: async () => { apiCalls++; return apiHint; },
};
const discovered = await buildDirectOftQuote(discoveryArgs);
assert.equal(apiCalls, 1);
assert.equal(discovered.userSteps.at(-1).transaction.encoded.to, addr(3));
assert.notEqual(discovered.userSteps.at(-1).transaction.encoded.data, envelope);
assert.equal(discovered.dstAmount, "999800", "still preserve actual contract fees");
await assert.rejects(buildDirectOftQuote({ ...discoveryArgs, dstToken: { ...dstToken, address: addr(9) } }), /No direct OFT mesh/);
wrongPeer = true;
await assert.rejects(buildDirectOftQuote(discoveryArgs), /No direct OFT mesh/);
wrongPeer = false;
apiCalls = 0;
await buildDirectOftQuote({ ...discoveryArgs, srcToken: { ...srcToken, address: addr(3) }, read: (params) => params.functionName === "token" && params.chain.chainKey === "ethereum" ? Promise.resolve(addr(3)) : peerRead(params) });
assert.equal(apiCalls, 0, "native token peers resolve before asking the API");
console.log("Discovery: nested OFT hints, token identity, reciprocal peers, fresh calldata and lazy API passed.");

if (process.env.LIVE_SIERRA_OFT === "1") {
  const ethereum = { ...srcChain, chainId: 1 };
  const avalanche = { ...dstChain, chainKey: "avalanche", chainId: 43114, nativeCurrency: { decimals: 18, symbol: "AVAX" } };
  const src = { ...srcToken, decimals: 6, symbol: "SIERRA", address: "0x6bf7788EAA948d9fFBA7E9bb386E2D3c9810e0fc" };
  const dst = { ...dstToken, chainKey: "avalanche", symbol: "SIERRA", address: "0x6E6080e15f8C0010d333D8CAeEaD29292ADb78f7" };
  const clients = {
    ethereum: createPublicClient({ transport: http("https://eth.drpc.org", { timeout: 15000, retryCount: 0 }) }),
    avalanche: createPublicClient({ transport: http("https://avalanche.drpc.org", { timeout: 15000, retryCount: 0 }) }),
  };
  const liveRead = ({ chain, ...params }) => clients[chain.chainKey].readContract(params);
  const payload = { srcChainKey: "ethereum", dstChainKey: "avalanche", srcTokenAddress: src.address, dstTokenAddress: dst.address,
    srcWalletAddress: addr(5), dstWalletAddress: addr(6), amount: "1000000", options: { amountType: "EXACT_SRC_AMOUNT" } };
  const response = await fetch("https://stargate.finance/api/vt/v1/quotes", { method: "POST", headers: { "Content-Type": "application/json", Referer: "https://stargate.finance/" }, body: JSON.stringify(payload) });
  assert.equal(response.ok, true);
  const api = await response.json();
  assert.ok(extractOftCandidates(api, ethereum, 30106).some((a) => a.toLowerCase() === src.address.toLowerCase()));
  for (const reverse of [false, true]) {
    const live = await buildDirectOftQuote({ ...args, metadata: {}, discoverPeers: true, srcChain: reverse ? avalanche : ethereum,
      dstChain: reverse ? ethereum : avalanche, srcToken: reverse ? dst : src, dstToken: reverse ? src : dst,
      amount: 1000000n, read: liveRead });
    assert.equal(live.dstAmount, "1000000");
    assert.equal(live.fees.length, 1);
    console.log("SIERRA mainnet read-only", reverse ? "Avalanche → Ethereum" : "Ethereum → Avalanche", JSON.stringify({
      srcAmount: live.srcAmount, dstAmount: live.dstAmount, fees: live.fees,
      target: live.userSteps.at(-1).transaction.encoded.to,
    }));
  }
  console.log("Stargate API destination amount:", api.quotes[0].dstAmount);
}

// Old OFTCore's unused uint64 maximum is in the shared denomination,
// despite the LD field name. A normal 100-token transfer must pass.
const legacyAmount = 100n * 10n ** 18n;
const uint64Max = (1n << 64n) - 1n;
const legacyRead = async (request) => {
  if (request.functionName === "quoteOFT") return [
    { minAmountLD: 0n, maxAmountLD: uint64Max }, [],
    { amountSentLD: request.args[0].amountLD, amountReceivedLD: request.args[0].amountLD },
  ];
  if (request.functionName === "quoteSend") return { nativeFee: 100n, lzTokenFee: 0n };
  return read(request);
};
configuredOptions = buildLayerZeroExecutorLzReceiveOption(65000n);
wrongPeer = false;
assert.equal((await buildDirectOftQuote({ ...args, amount: legacyAmount, read: legacyRead })).dstAmount, "100000000");
for (const [min, max, fees] of [[0n, legacyAmount - 1n, []], [1n, uint64Max, []], [0n, uint64Max, [{}]]]) {
  await assert.rejects(buildDirectOftQuote({ ...args, amount: legacyAmount, read: async (request) =>
    request.functionName === "quoteOFT" ? [{ minAmountLD: min, maxAmountLD: max }, fees,
      { amountSentLD: legacyAmount, amountReceivedLD: legacyAmount }] : legacyRead(request),
  }), /outside the direct OFT transfer limits/);
}
await assert.rejects(buildDirectOftQuote({ ...args, amount: (uint64Max + 1n) * 10n ** 12n, read: legacyRead }), /outside the direct OFT transfer limits|integer limit/);
console.log("Legacy OFT uint64 placeholder, real limits and shared overflow guards passed.");

if (process.env.LIVE_USDE_OFT === "1") {
  const avalanche = { ...srcChain, chainKey: "avalanche", chainId: 43114 };
  const ethereum = { ...srcChain, chainId: 1 };
  const avaxToken = { ...srcToken, chainKey: "avalanche", symbol: "USDe", address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34" };
  const ethToken = { ...srcToken, symbol: "USDe", address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3" };
  const clients = {
    ethereum: createPublicClient({ transport: http("https://eth.drpc.org") }),
    avalanche: createPublicClient({ transport: http("https://avalanche.drpc.org") }),
  };
  for (const units of [1n, 20n, 100n, 1000n]) {
    const live = await buildDirectOftQuote({ ...args, metadata: {}, discoverPeers: true,
      srcChain: avalanche, dstChain: ethereum, srcToken: avaxToken, dstToken: ethToken,
      amount: units * 10n ** 18n, read: ({ chain, ...request }) => clients[chain.chainKey].readContract(request),
    });
    assert.equal(live.dstAmount, String(units * 10n ** 18n));
    assert.equal(live.userSteps.at(-1).transaction.encoded.to.toLowerCase(), avaxToken.address);
    console.log(`USDe Avalanche → Ethereum read-only: ${units} → ${units}`);
  }
  const response = await fetch("https://stargate.finance/api/vt/v1/quotes", { method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://stargate.finance/" },
    body: JSON.stringify({ srcChainKey: "avalanche", dstChainKey: "ethereum", srcTokenAddress: avaxToken.address,
      dstTokenAddress: ethToken.address, srcWalletAddress: addr(5), dstWalletAddress: addr(6),
      amount: String(legacyAmount), options: { amountType: "EXACT_SRC_AMOUNT" } }),
  });
  assert.equal(response.ok, true);
  const api = await response.json();
  assert.ok(api.quotes?.length);
  console.log("Stargate USDe quote for 100:", api.quotes[0].dstAmount);
}
