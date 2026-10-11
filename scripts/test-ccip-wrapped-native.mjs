import assert from 'node:assert/strict';
import { decodeFunctionData, zeroAddress } from 'viem';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { CCIP_WRAPPED_NATIVE: configs, addWrappedNativeRoutes, nativeConversionTransaction, WRAPPED_NATIVE_ABI, TAO_NATIVE_VAULT_ABI } = load('ccip-wrapped-native');
const { normalizeCcipQuote, ccipFeeQuery } = load('ccip');
const { assertCcipQuote, executeCcipTransfer, CCIP_ROUTER_ABI } = load('ccip-execution');
const sender = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + '3'.repeat(64);
const chains = Object.entries(configs).map(([id, config]) => ({ chainId: Number(id), chainKey: id, chainType: 'EVM',
  nativeCurrency: { chainKey: id, address: zeroAddress, decimals: 18, symbol: config.symbol, name: config.symbol },
  ccip: { selector: config.selector, selectorName: id, router: config.router } }));
const ethereum = chains.find(c => c.chainId === 1);
// Fixture remote deployments are intentionally different assets on the same
// chain: HSK must not turn into ETH, and symbols cannot establish a route.
const locals = chains.filter(c => c !== ethereum).map(c => ({ chainKey: c.chainKey, address: configs[c.chainId].token, decimals: 18, symbol: `W${c.nativeCurrency.symbol}`,
  ccip: { destinations: [{ chainKey: '1', address: `0x${c.chainId.toString(16).padStart(40, '0')}` }] } }));
const remotes = locals.map(t => ({ chainKey: '1', address: t.ccip.destinations[0].address, decimals: 18, symbol: t.symbol,
  ccip: { destinations: [{ chainKey: t.chainKey, address: t.address }] } }));
const catalog = addWrappedNativeRoutes({ chains, tokens: [...locals, ...remotes] });
for (const chain of chains.filter(c => c !== ethereum)) {
  const remote = remotes.find(t => t.ccip.destinations[0].chainKey === chain.chainKey);
  const request = { srcChainKey: chain.chainKey, dstChainKey: '1', srcTokenAddress: zeroAddress, dstTokenAddress: remote.address,
    srcWalletAddress: sender, dstWalletAddress: recipient, amount: '10000000000000000' };
  const quote = normalizeCcipQuote(catalog, request, { ccipFee: '1000' }).quotes[0];
  assert.equal(quote.ccip.wrapping.source, configs[chain.chainId].token);
  assert.equal(quote.ccip.wrapping.destination, undefined);
  assert.equal(ccipFeeQuery(catalog, request).get('token'), configs[chain.chainId].token);
  assert.equal(quote.dstAmount, request.amount);
  assertCcipQuote(quote, request, chain);
  const reverse = { ...request, srcChainKey: '1', dstChainKey: chain.chainKey, srcTokenAddress: remote.address, dstTokenAddress: zeroAddress };
  const inbound = normalizeCcipQuote(catalog, reverse, { ccipFee: '1000' }).quotes[0];
  assert.equal(inbound.ccip.wrapping.destination, configs[chain.chainId].token);
  assertCcipQuote(inbound, reverse, ethereum);
  for (const patch of [{ source: recipient }, { destination: recipient }, { source: undefined }]) {
    assert.throws(() => assertCcipQuote({ ...quote, ccip: { ...quote.ccip, wrapping: { ...quote.ccip.wrapping, ...patch } } }, request, chain));
  }
  for (const operation of ['wrap', 'unwrap']) {
    const tx = nativeConversionTransaction(chain.chainId, configs[chain.chainId].token, request.amount, operation);
    assert.equal(tx.to, configs[chain.chainId].vault?.address ?? configs[chain.chainId].token);
    assert.equal(tx.value, operation === 'wrap' ? BigInt(request.amount) : 0n);
    const decoded = decodeFunctionData({ abi: configs[chain.chainId].vault ? TAO_NATIVE_VAULT_ABI : WRAPPED_NATIVE_ABI, data: tx.data });
    assert.equal(decoded.functionName, configs[chain.chainId].vault ? operation === 'wrap' ? 'depositLiquid' : 'withdrawLiquid' : operation === 'wrap' ? 'deposit' : 'withdraw');
    if (configs[chain.chainId].vault) assert.equal(decoded.args.at(-1), operation === 'wrap' ? BigInt(request.amount) / 1000000000n : BigInt(request.amount));
  }
}
assert.equal(addWrappedNativeRoutes({ chains, tokens: [] }).tokens.length, 0);
assert.equal(addWrappedNativeRoutes({ chains: chains.map(c => ({ ...c, ccip: { ...c.ccip, router: recipient } })), tokens: locals }).tokens.length, locals.length, 'changed router cannot enable native aliases');
for (const args of [[56, recipient, '1'], [177, recipient, '1'], [177, configs[177].token, '0'], [177, configs[177].token, '-1'], [177, configs[177].token, (2n ** 256n).toString()]]) assert.throws(() => nativeConversionTransaction(...args, 'wrap'));

const chain = chains.find(c => c.chainId === 177), remote = remotes.find(t => t.symbol === 'WHSK');
const request = { srcChainKey: '177', dstChainKey: '1', srcTokenAddress: zeroAddress, dstTokenAddress: remote.address, srcWalletAddress: sender, dstWalletAddress: recipient, amount: '10000000000000000' };
const quote = normalizeCcipQuote(catalog, request, { ccipFee: '1000' }).quotes[0];
function harness(fail) {
  const events = [];
  let wrapped = false, approved = false;
  return { events, deps: {
    assertContext() { if (fail === 'context' && wrapped) throw Error('context changed'); },
    refresh: async () => structuredClone(quote),
    read: async ({ address, functionName }) => {
      if (functionName === 'getFee') return fail === 'fee' ? 1011n : 999n;
      assert.equal(address, configs[177].token);
      if (functionName === 'balanceOf') return wrapped ? BigInt(request.amount) - (fail === 'balance' ? 1n : 0n) : 0n;
      assert.equal(functionName, 'allowance'); return approved ? BigInt(request.amount) : 0n;
    },
    send: async (tx, kind) => {
      events.push(`send:${kind}`);
      if (fail === 'rejected' && kind === 'wrap') throw Error('rejected');
      if (kind === 'wrap') assert.equal(tx.value, BigInt(request.amount));
      if (kind === 'bridge') {
        const decoded = decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: tx.data });
        assert.equal(decoded.args[1].tokenAmounts[0].token.toLowerCase(), configs[177].token.toLowerCase());
        assert.equal(tx.value, 999n, 'principal is already wrapped; only CCIP fee goes to router');
      }
      return hash;
    },
    wait: async (_, kind) => { events.push(`wait:${kind}`); if (kind === 'wrap' && fail === 'timeout') throw Error('pending'); if (kind === 'wrap') wrapped = true; if (kind === 'approval') approved = true; return hash; },
    wrapped: (_, confirmed) => events.push(confirmed ? 'wrap:confirmed' : 'wrap:saved'),
    submitted: (_, confirmed) => events.push(confirmed ? 'bridge:confirmed' : 'bridge:saved'), step() {},
  } };
}
const ok = harness();
await executeCcipTransfer(quote, request, chain, sender, ok.deps);
assert.deepEqual(ok.events, ['send:wrap','wrap:saved','wait:wrap','wrap:confirmed','send:approval','wait:approval','send:bridge','bridge:saved','wait:bridge','bridge:confirmed']);
for (const fail of ['context', 'rejected', 'balance', 'timeout', 'fee']) {
  const h = harness(fail);
  await assert.rejects(executeCcipTransfer(quote, request, chain, sender, h.deps));
  assert.ok(!h.events.includes('send:bridge'), `${fail} cannot send CCIP`);
  if (fail === 'timeout') assert.deepEqual(h.events, ['send:wrap','wrap:saved','wait:wrap'], 'persist source wrapping before waiting; never rewrap automatically');
}
const noTracking = harness(); delete noTracking.deps.wrapped;
await assert.rejects(executeCcipTransfer(quote, request, chain, sender, noTracking.deps), /tracking/);
assert.equal(noTracking.events.length, 0);
console.log('Native CCIP: exact network/token lanes, bidirectional aliases, conversion calldata, wrapper and router binding, staged send order, persistence before confirmation and interrupted/rejected wrapping passed.');

for (const [amount, operation] of [['1000000000000001','wrap'], ['1000000000000000','wrap'], ['9000000000000000','unwrap']]) assert.throws(() => nativeConversionTransaction(964, configs[964].token, amount, operation), /TAO/);

// Deployment changes and the CCIP risk signal must stop the quote before any
// wallet conversion. RPC responses are injected here; live probes check code.
const viem = await import('viem');
let wrongChain = false, wrongCode = false, wrongImplementation = false, wrongRoot = false, vaultPaused = false, riskPaused = false;
const rpcLoad = createLoader({ viem: { ...viem, http: url => url,
  keccak256: code => code === '0x01' ? (wrongCode ? '0x00' : configs[964].codeHash) : configs[964].vault.codeHash,
  createPublicClient: () => ({
    getChainId: async () => wrongChain ? 1 : 964,
    getCode: async ({ address }) => address === configs[964].token ? '0x01' : '0x02',
    getStorageAt: async () => wrongImplementation ? '0x01' : configs[964].implementation,
    readContract: async ({ functionName }) => {
      if (functionName === 'positionOf') return ['0x' + '1'.repeat(64), wrongRoot ? 1n : 0n];
      if (functionName === 'isListed') return true;
      if (functionName === 'isPaused') return vaultPaused;
      if (functionName === 'getArmProxy') return recipient;
      if (functionName === 'isCursed') return riskPaused;
      throw Error(functionName);
    },
  }),
} });
const { verifyCcipWrappedNative, verifyCcipNativeSource } = rpcLoad('ccip-native-rpc');
await verifyCcipWrappedNative([964]);
for (const flag of ['chain', 'code', 'implementation', 'root', 'vault']) {
  wrongChain = flag === 'chain'; wrongCode = flag === 'code'; wrongImplementation = flag === 'implementation'; wrongRoot = flag === 'root'; vaultPaused = flag === 'vault';
  await assert.rejects(verifyCcipWrappedNative([964]), /deployment|vault|implementation/);
}
await verifyCcipNativeSource(964, configs[8453].selector);
riskPaused = true;
await assert.rejects(verifyCcipNativeSource(964, configs[8453].selector), /temporarily paused/);
console.log('Native deployment gate: chain/runtime/proxy changes, TAO root position and vault pause, CCIP risk pause all block conversion.');
