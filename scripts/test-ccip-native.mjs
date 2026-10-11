import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters, zeroAddress } from 'viem';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { CCIP_NATIVE_NETWORKS: networks, addCcipNativeTokens, isCcipNative } = load('ccip-native');
const { normalizeCcipQuote, resolveCcipQuote, mergeBridgeTokens } = load('ccip');
const { assertCcipQuote, executeCcipTransfer, CCIP_ROUTER_ABI } = load('ccip-execution');
const nativeAddress = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const sender = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), hash = '0x' + '3'.repeat(64);
const chains = Object.entries(networks).map(([id, config]) => ({ chainId: Number(id), chainKey: id, chainType: 'EVM',
  nativeCurrency: { chainKey: id, address: nativeAddress, decimals: 18, symbol: 'ETH', name: 'Ether' },
  ccip: { selector: config.selector, selectorName: id, router: config.router } }));
const wrapped = chains.map(chain => ({ chainKey: chain.chainKey, address: networks[chain.chainId].wrappedToken, decimals: 18, symbol: 'WETH', name: 'Wrapped Ether',
  ccip: { destinations: chains.filter(dest => dest !== chain).map(dest => ({ chainKey: dest.chainKey, address: networks[dest.chainId].wrappedToken })) } }));
const catalog = addCcipNativeTokens({ chains, tokens: wrapped });
assert.equal(catalog.tokens.filter(token => isCcipNative(token.address)).length, 4);
assert.equal(addCcipNativeTokens({ chains, tokens: [] }).tokens.length, 0, 'no invented WETH deployments');
const unsupported = { ...chains[0], chainId: 56 };
assert.equal(addCcipNativeTokens({ chains: [unsupported], tokens: wrapped }).tokens.length, wrapped.length);
const base = [{ ...chains[0].nativeCurrency }];
assert.equal(mergeBridgeTokens(base, catalog.tokens).find(token => token.chainKey === '1' && isCcipNative(token.address)).bridgeProviders.join(','), 'layerzero,ccip');
const directional = addCcipNativeTokens({ chains, tokens: wrapped.map(token => ({ ...token, ccip: { destinations: token.chainKey === '1' ? [{ chainKey: '8453', address: networks[8453].wrappedToken }] : [] } })) });
assert.equal(directional.tokens.find(token => token.chainKey === '1' && isCcipNative(token.address)).ccip.destinations.length, 1, 'preserve directed lanes');
const request = { srcChainKey: '1', dstChainKey: '8453', srcTokenAddress: nativeAddress, dstTokenAddress: nativeAddress,
  srcWalletAddress: sender, dstWalletAddress: sender, amount: '1000000000000001' };
for (const change of [{ srcWalletAddress: undefined }, { dstWalletAddress: other }, { dstTokenAddress: networks[8453].wrappedToken }]) {
  assert.throws(() => resolveCcipQuote(catalog, { ...request, ...change }));
}
const quote = normalizeCcipQuote(catalog, request, { ccipFee: '1000' }).quotes[0];
assert.equal(quote.dstAmount, request.amount);
assertCcipQuote(quote, request, chains[0]);
for (const change of [{ router: other }, { native: undefined }, { native: { ...quote.ccip.native, destinationWrapper: other } },
  { native: { ...quote.ccip.native, sourceWrappedToken: other } }, { destinationSelector: networks[10].selector }]) {
  assert.throws(() => assertCcipQuote({ ...quote, ccip: { ...quote.ccip, ...change } }, request, chains[0]));
}
function harness(options = {}) {
  const events = [];
  return { events, deps: {
    assertContext() { if (options.changed) throw Error('wallet changed'); },
    refresh: async () => structuredClone(quote),
    read: async args => { assert.equal(args.functionName, 'getFee', 'native principal needs no allowance'); assert.equal(args.account, sender); return options.fee ?? 999n; },
    send: async (tx, kind) => {
      assert.equal(kind, 'bridge'); assert.equal(tx.to, networks[1].wrapper);
      assert.equal(tx.value, BigInt(request.amount) + 999n, 'exact principal plus refreshed fee');
      const decoded = decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: tx.data });
      assert.equal(decoded.functionName, 'ccipSend'); assert.equal(decoded.args[0].toString(), networks[8453].selector);
      const message = decoded.args[1];
      assert.equal(decodeAbiParameters([{ type: 'address' }], message.receiver)[0].toLowerCase(), networks[8453].wrapper);
      assert.equal(message.tokenAmounts[0].token, zeroAddress); assert.equal(message.tokenAmounts[0].amount, BigInt(request.amount));
      assert.equal(message.data, '0x'); assert.equal(message.feeToken, zeroAddress);
      assert.deepEqual(decodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], '0x' + message.extraArgs.slice(10)), [100000n, true]);
      events.push('send'); if (options.reject) throw Error('rejected'); return hash;
    },
    wait: async () => { events.push('wait'); if (options.timeout) throw Error('timeout'); return hash; },
    submitted: (_, confirmed) => events.push(confirmed ? 'confirmed' : 'saved'), step() {},
  } };
}
const ok = harness();
await executeCcipTransfer(quote, request, chains[0], sender, ok.deps);
assert.deepEqual(ok.events, ['send', 'saved', 'wait', 'confirmed']);
for (const options of [{ fee: 1011n }, { changed: true }, { reject: true }, { timeout: true }]) {
  const h = harness(options);
  await assert.rejects(executeCcipTransfer(quote, request, chains[0], sender, h.deps));
  if (options.timeout) assert.deepEqual(h.events, ['send', 'saved', 'wait']);
  else assert.ok(!h.events.includes('saved'));
}
await assert.rejects(executeCcipTransfer(quote, request, chains[0], other, harness().deps), /same address/);
let verified = 0, changedCode = false, feeData = '1000';
const api = createLoader({ './ccip-native-rpc': { verifyCcipNativeDeployments: async (src, dst) => {
  assert.equal(src, 1); assert.equal(dst, 8453); verified++; if (changedCode) throw Error('deployment changed');
} } }, { fetch: async (url, init) => {
  if (url.includes('transfer.layerzero-api.com')) return Response.json({ chains });
  if (url.includes('/chains?')) return Response.json({ data: { evm: Object.fromEntries(chains.map(chain => [chain.chainKey, {
    chainId: chain.chainId, internalId: chain.chainKey, displayName: chain.chainKey, selector: chain.ccip.selector, router: chain.ccip.router, supported: true,
  }])) } });
  if (url.includes('/tokens?')) return Response.json({ data: { WETH: Object.fromEntries(wrapped.map(token => [token.chainKey, {
    tokenAddress: token.address, decimals: 18, symbol: 'WETH', name: 'Wrapped Ether', destinations: token.ccip.destinations.map(d => d.chainKey),
  }])) } });
  if (url === 'https://app.transporter.io/') return new Response('', { status: 503 });
  if (url.includes('getLaneLatency')) return Response.json({ totalMs: 1000 });
  assert.ok(url.endsWith('/ccipData/getFeeData'));
  const body = JSON.parse(init.body);
  assert.equal(body.routerAddress, networks[1].wrapper); assert.equal(body.ccipMessage.tokenAmounts[0].token, zeroAddress);
  assert.equal(body.ccipMessage.tokenAmounts[0].amount, request.amount);
  return Response.json(feeData);
} })('ccip-api');
assert.ok((await api.getCcipQuote(request)).quotes[0].ccip.native);
assert.equal(verified, 1);
changedCode = true;
await assert.rejects(api.getCcipQuote(request), /deployment changed/);
changedCode = false; feeData = -1;
await assert.rejects(api.getCcipQuote(request), /invalid|Invalid/);
console.log('CCIP native: catalog lanes, recipient and wrapper binding, API quoting/deployment gate, exact principal+fee, no approvals, rejection and confirmation recovery passed.');
