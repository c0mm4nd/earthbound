import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, decodeFunctionData, erc20Abi, http, padHex } from "viem";
import { createLoader } from "./helpers/load-ts.mjs";

const load = createLoader();
const { buildDirectOftQuote } = load("direct-oft");
const { buildDirectStargateQuote, stargateAbi } = load("direct-stargate");
const { STARGATE_DEPLOYMENTS, findStargateRoute } = load("stargate-deployments");
const { buildLayerZeroExecutorLzReceiveOption, getLayerZeroV2EndpointId } = load("custom-oft");
const address = n => `0x${n.toString(16).padStart(40, "0")}`;
const from = address(1), to = address(2);
const amount = 1_000_000_000n;
const deployment = (chainKey, asset = "USDC") => STARGATE_DEPLOYMENTS.find(d => d.chainKey === chainKey && d.asset === asset);
const chain = d => ({ chainKey: d.chainKey, chainId: d.chainId, chainType: "EVM", nativeCurrency: { symbol: d.chainKey === "flow" ? "FLOW" : d.chainKey === "bera" ? "BERA" : "ETH", decimals: 18 } });
const token = d => ({ chainKey: d.chainKey, address: d.token, decimals: 6, symbol: d.asset });

function fixture(sourceKey = "flow", destinationKey = "ethereum", settings = {}) {
  const source = deployment(sourceKey), destination = deployment(destinationKey);
  const calls = [];
  const read = async request => {
    calls.push(request);
    const { chain: c, address: target, functionName, args: params = [] } = request;
    const local = c.chainKey === sourceKey ? source : destination;
    const remote = local === source ? destination : source;
    const override = settings.override?.(request, local, remote);
    if (override !== undefined) return override;
    switch (functionName) {
      case "getAddressConfig": return { tokenMessaging: local.messaging };
      case "localEid": return getLayerZeroV2EndpointId(local.chainKey);
      case "oftVersion": return ["0x02e49c2c", 0n];
      case "stargateType": return local.type;
      case "status": return 1;
      case "sharedDecimals": return 6;
      case "token": return local.token;
      case "decimals": return 6;
      case "approvalRequired": return true;
      case "peers":
        assert.equal(target, local.messaging, "Hydra peers belong to TokenMessaging");
        assert.equal(params[0], getLayerZeroV2EndpointId(remote.chainKey));
        return padHex(remote.messaging, { size: 32 });
      case "assetIds":
        assert.equal(target, local.messaging);
        assert.equal(params[0], local.address);
        return 1;
      case "stargateImpls":
        assert.equal(target, local.messaging);
        assert.equal(params[0], 1);
        return local.address;
      case "enforcedOptions":
        assert.equal(target, source.messaging);
        assert.equal(params[1], 1, "Taxi message type");
        return buildLayerZeroExecutorLzReceiveOption(200000n);
      case "quoteOFT":
        assert.equal(request.account, from);
        return [{ minAmountLD: 1n, maxAmountLD: settings.credit ?? amount * 2n }, [], {
          amountSentLD: settings.sent ?? params[0].amountLD,
          amountReceivedLD: settings.received ?? params[0].amountLD - 2000001n,
        }];
      case "quoteSend":
        assert.equal(request.account, from);
        assert.equal(params[0].minAmountLD, settings.received ?? params[0].amountLD - 2000001n);
        assert.equal(params[0].oftCmd, "0x");
        assert.equal(params[0].composeMsg, "0x");
        assert.equal(params[0].extraOptions, "0x");
        return { nativeFee: 100n, lzTokenFee: 0n };
      case "allowance":
        assert.equal(target, source.token);
        assert.equal(params[0], from);
        assert.equal(params[1], source.address, "approve the Stargate contract, never a wrapper");
        return settings.allowance ?? 0n;
      case "poolBalance": return amount * 2n;
      case "balanceOf": return amount * 2n;
      default: throw Error(`Unexpected call: ${functionName}`);
    }
  };
  return { calls, source, destination, args: {
    metadata: {}, srcChain: chain(source), dstChain: chain(destination), srcToken: token(source), dstToken: token(destination),
    amount, from, to, read, discoverPeers: true,
    fetchDiscoveryQuote: () => { throw Error("Stargate direct routes must not require the third-party quote API"); },
  } };
}

test("FLOW USDC routes through Hydra without metadata and preserves the protocol fee", async () => {
  const f = fixture();
  const q = await buildDirectOftQuote(f.args);
  assert.equal(q.routeSteps[0].type, "DIRECT_STARGATE_V2");
  assert.equal(q.dstAmount, "997999999");
  assert.equal(q.dstAmountMin, q.dstAmount);
  assert.equal(q.fees.find(f => f.type === "PROTOCOL").amount, "2000001");
  assert.equal(q.userSteps.length, 2);
  const approval = decodeFunctionData({ abi: erc20Abi, data: q.userSteps[0].transaction.encoded.data });
  assert.equal(approval.args[0].toLowerCase(), f.source.address.toLowerCase());
  assert.equal(approval.args[1], amount);
  const tx = q.userSteps.at(-1).transaction.encoded;
  assert.equal(tx.to, f.source.address);
  assert.equal(tx.value, "100");
  assert.equal(tx.from, from);
  assert.equal(tx.chainId, 747);
  assert.equal(tx.data.slice(0, 10), "0xcbef2aa9", "official IStargate.sendToken selector");
  const send = decodeFunctionData({ abi: stargateAbi, data: tx.data });
  assert.equal(send.functionName, "sendToken");
  assert.equal(send.args[0].amountLD, amount);
  assert.equal(send.args[0].minAmountLD, 997999999n);
  assert.equal(send.args[0].to, padHex(to, { size: 32 }));
  assert.equal(send.args[2], from);
  assert.equal(q.directOft.nativeFee, "100");
  assert.ok(q.directOft.meshKey.includes(f.source.messaging));
});

test("Bera's zero fee and pool rewards remain in the quote", async () => {
  const zero = await buildDirectOftQuote(fixture("bera", "ethereum", { received: amount }).args);
  assert.equal(zero.dstAmount, amount.toString());
  assert.equal(zero.fees.length, 1);
  const reward = await buildDirectOftQuote(fixture("ethereum", "flow", { received: amount + 100n }).args);
  assert.equal(reward.dstAmount, (amount + 100n).toString());
  assert.equal(reward.fees[1].amount, "-100");
  assert.match(reward.fees[1].description, /reward/);
});

test("nonzero insufficient allowance resets; sufficient allowance sends directly", async () => {
  const reset = await buildDirectOftQuote(fixture("flow", "ethereum", { allowance: 1n }).args);
  assert.equal(reset.userSteps.length, 3);
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: reset.userSteps[0].transaction.encoded.data }).args[1], 0n);
  const approved = await buildDirectOftQuote(fixture("flow", "ethereum", { allowance: amount }).args);
  assert.equal(approved.userSteps.length, 1);
});

test("registry binds chain IDs and token addresses, never token names", async () => {
  const { args } = fixture();
  assert.equal(findStargateRoute({ ...args.srcChain, chainId: 1 }, args.dstChain, args.srcToken, args.dstToken), null);
  assert.equal(findStargateRoute(args.srcChain, args.dstChain, { ...args.srcToken, address: address(99) }, args.dstToken), null);
  assert.equal(findStargateRoute(args.srcChain, args.dstChain, args.srcToken, token(deployment("ethereum", "USDT"))), null);
  assert.equal(findStargateRoute(args.srcChain, args.dstChain, { ...args.srcToken, chainKey: "bera" }, args.dstToken), null);
  await assert.rejects(buildDirectStargateQuote({ ...args, srcToken: { ...args.srcToken, address: address(99) } }), /No registered/);
  for (const [key, asset] of [["flow", "USDT"], ["base", "USDC"], ["polygon", "USDC"]]) {
    const src = deployment(key, asset), dst = deployment("ethereum", asset);
    assert.ok(findStargateRoute(chain(src), chain(dst), token(src), token(dst)));
  }
});

for (const [name, override, error] of [
  ["changed messaging contract", r => r.functionName === "getAddressConfig" ? { tokenMessaging: address(99) } : undefined, /configuration changed/],
  ["wrong endpoint", r => r.functionName === "localEid" ? 123 : undefined, /configuration changed/],
  ["standard OFT wire format", r => r.functionName === "oftVersion" ? ["0x02e49c2c", 1n] : undefined, /configuration changed/],
  ["wrong pool type", r => r.functionName === "stargateType" ? 5 : undefined, /configuration changed/],
  ["paused destination", r => r.chain.chainKey === "ethereum" && r.functionName === "status" ? 3 : undefined, /paused/],
  ["different token", r => r.functionName === "token" ? address(99) : undefined, /selected asset/],
  ["wrong decimals", r => r.functionName === "decimals" ? 18 : undefined, /decimal configuration/],
  ["incompatible shared decimals", r => r.chain.chainKey === "ethereum" && r.functionName === "sharedDecimals" ? 5 : undefined, /shared decimals/],
  ["missing peer", r => r.functionName === "peers" ? padHex(address(0), { size: 32 }) : undefined, /peers do not match/],
  ["nonreciprocal destination peer", r => r.chain.chainKey === "ethereum" && r.functionName === "peers" ? padHex(address(99), { size: 32 }) : undefined, /peers do not match/],
  ["unregistered asset", r => r.functionName === "assetIds" ? 0 : undefined, /not registered/],
  ["wrong implementation", r => r.functionName === "stargateImpls" ? address(99) : undefined, /asset mapping/],
  ["missing receive gas", r => r.functionName === "enforcedOptions" ? "0x" : undefined, /receive gas/],
  ["insufficient pool accounting balance", r => r.functionName === "poolBalance" ? 1n : undefined, /insufficient liquidity/],
  ["insufficient actual pool tokens", r => r.functionName === "balanceOf" ? 1n : undefined, /insufficient liquidity/],
  ["LZ token payment", r => r.functionName === "quoteSend" ? { nativeFee: 1n, lzTokenFee: 1n } : undefined, /LZ token payment/],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(buildDirectOftQuote(fixture("flow", "ethereum", { override }).args), error);
  });
}

test("rejects mismatched asset IDs even with individually valid implementation mappings", async () => {
  const f = fixture("flow", "ethereum", { override: (r, local) => {
    if (r.chain.chainKey !== "ethereum") return;
    if (r.functionName === "assetIds") return 2;
    if (r.functionName === "stargateImpls") return local.address;
  } });
  await assert.rejects(buildDirectOftQuote(f.args), /asset IDs/);
});

test("rejects partial transfers, exhausted credit, zero receipts and wire overflow", async () => {
  for (const settings of [{ credit: 0n }, { credit: amount - 1n }, { sent: amount - 1n }, { received: 0n }, { received: 1n << 64n }]) {
    await assert.rejects(buildDirectOftQuote(fixture("flow", "ethereum", settings).args), /transfer limits/);
  }
  for (const n of [0n, -1n, 1n << 64n]) {
    await assert.rejects(buildDirectOftQuote({ ...fixture().args, amount: n }), /amount|limits/i);
  }
  await assert.rejects(buildDirectOftQuote({ ...fixture().args, to: address(0) }), /recipient/);
});

test("execution refresh re-reads credit, liquidity, allowance and fees", async () => {
  const settings = {};
  const f = fixture("flow", "ethereum", settings);
  const q = await buildDirectOftQuote(f.args);
  settings.received = amount - 3000001n;
  settings.allowance = amount;
  const fresh = await buildDirectOftQuote(f.args);
  assert.equal(q.directOft.meshKey, fresh.directOft.meshKey);
  assert.ok(BigInt(fresh.dstAmount) < BigInt(q.dstAmountMin));
  assert.equal(fresh.userSteps.length, 1);
  settings.credit = 0n;
  await assert.rejects(buildDirectOftQuote(f.args), /credit/);
});

test("mainnet read-only Hydra/Pool quotes and transaction construction", { skip: process.env.LIVE_STARGATE !== "1" }, async () => {
  const clients = Object.fromEntries(Object.entries({
    flow: "https://mainnet.evm.nodes.onflow.org", bera: "https://rpc.berachain.com", ethereum: "https://eth.drpc.org",
  }).map(([key, url]) => [key, createPublicClient({ transport: http(url, { timeout: 20000, retryCount: 1 }) })]));
  for (const [src, dst] of [["flow", "ethereum"], ["bera", "ethereum"], ["flow", "bera"], ["ethereum", "flow"]]) {
    const f = fixture(src, dst);
    const q = await buildDirectOftQuote({ ...f.args, read: ({ chain, ...request }) => clients[chain.chainKey].readContract(request) });
    assert.equal(q.routeSteps[0].type, "DIRECT_STARGATE_V2");
    const tx = q.userSteps.at(-1).transaction.encoded;
    const send = decodeFunctionData({ abi: stargateAbi, data: tx.data });
    assert.equal(send.functionName, "sendToken");
    assert.equal(send.args[0].minAmountLD.toString(), q.dstAmount);
    assert.equal(tx.value, q.directOft.nativeFee);
    console.log(`${src} → ${dst}`, JSON.stringify({ src: q.srcAmount, dst: q.dstAmount, fees: q.fees }));
  }
});
