// Read-only tests. LIVE_NON_EVM_OFT=1 adds mainnet quotes; never signs/broadcasts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createPublicClient, http, encodeFunctionData, decodeFunctionData, encodeAbiParameters, parseAbiParameters, padHex, keccak256, stringToHex, toHex } from 'viem';
const require = createRequire(import.meta.url);
let requestFetch = (...args) => fetch(...args);
function load(name) {
  const m = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer, Uint8Array, atob, btoa, AbortSignal, setTimeout,
    fetch: (...args) => requestFetch(...args), require: id => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const { buildDirectOftQuote, extractOftCandidates, directOftRecipient, supportsDirectOftRoute } = load('direct-oft');
const { createNonEvmReceiveAdapter } = load('direct-oft-receive');
const { readNonEvmReceiveState } = load('direct-oft-receive-state');
const { layerZeroOftV2Abi } = load('custom-oft');
const { tronAccount, tonAccount, nonEvmTokenMatches } = load('direct-oft-address');
const from = '0x1111111111111111111111111111111111111111';
const ethereum = { chainKey: 'ethereum', chainType: 'EVM', chainId: 1, nativeCurrency: { symbol: 'ETH', decimals: 18 } };
const adapter = '0x2222222222222222222222222222222222222222';
const peer = padHex('0x1234', { size: 32 });
assert.equal(directOftRecipient('APTOS', '0x1234'), peer);
assert.equal(directOftRecipient('SUI', '0x1234'), peer);
assert.throws(() => directOftRecipient('STARKNET', '0x' + 'f'.repeat(64)), /Invalid/);
assert.throws(() => directOftRecipient('APTOS', '0x0'), /Invalid/);
assert.equal(tronAccount('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'), padHex('0x74472e7d35395a6b5add427eecb7f4b62ad2b071', { size: 32 }));
assert.throws(() => tronAccount('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU8'), /checksum/);
assert.equal(tronAccount(padHex(adapter, { size: 32 })), padHex(adapter, { size: 32 }));
assert.throws(() => tronAccount('0x' + '11'.repeat(32)), /Invalid/);
assert.throws(() => tonAccount('-1:' + '1'.repeat(64)), /Invalid/);
assert.ok(nonEvmTokenMatches('SUI', '0x2::coin::CoinMetadata<0x1::a::A>', '0x02::coin::CoinMetadata<0x01::a::A>'));
assert.ok(!nonEvmTokenMatches('SUI', '0x1::a::A', '0x1::a::a'));
assert.equal(supportsDirectOftRoute('EVM', 'SUI'), true);
assert.equal(supportsDirectOftRoute('SUI', 'EVM'), false);
const send = (overrides = {}) => encodeFunctionData({ abi: layerZeroOftV2Abi, functionName: 'send', args: [{ dstEid: 30378, to: peer,
  amountLD: 10000n, minAmountLD: 10000n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x', ...overrides }, { nativeFee: 1n, lzTokenFee: 0n }, from] });
const quote = (data = send(), steps = [{ type: 'OFT_V2' }]) => ({ quotes: [{ routeSteps: steps, userSteps: [{ type: 'TRANSACTION', chainType: 'EVM', chainKey: 'ethereum', transaction: { encoded: { to: adapter, data } } }] }] });
assert.equal(extractOftCandidates(quote(), ethereum, 30378)[0], adapter);
assert.equal(extractOftCandidates(quote(send({ composeMsg: '0x1234' })), ethereum, 30378).length, 0);
assert.equal(extractOftCandidates(quote(send({ oftCmd: '0x01' })), ethereum, 30378).length, 0);
assert.equal(extractOftCandidates(quote(send({ dstEid: 30110 })), ethereum, 30378).length, 0);
assert.equal(extractOftCandidates(quote(send(), [{ type: 'OFT_V2' }, { type: 'OFT_V2' }]), ethereum, 30378).length, 0);
assert.equal(extractOftCandidates(quote(send(), [{ type: 'OFT_V2_MULTIHOP' }]), ethereum, 30378).length, 0);
const envelope = '0x571d3dc7' + encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[],bytes32'), [[{ target: adapter, value: 1n, callData: send() }], padHex('0x1', { size: 32 })]).slice(2);
assert.equal(extractOftCandidates(quote(envelope), ethereum, 30378)[0], adapter);
const state = { addressBytes32: peer, tokenAddress: '0x42', decimals: 6, sharedDecimals: 6, peer: padHex(adapter, { size: 32 }), maxAmountLD: '1000000' };
const receiveArgs = { chainType: 'APTOS', address: peer, token: '0x42', selectedToken: { address: '0x42', decimals: 6 }, remoteEid: 30101, recipient: '0x1234' };
const receive = await createNonEvmReceiveAdapter({ ...receiveArgs, loadState: async () => state });
await receive.validateReceive('0x1234', 1000000n);
await assert.rejects(receive.validateReceive('0x1234', 1000001n), /capacity/);
await assert.rejects(receive.validateReceive('0x1235', 1n), /Recipient changed/);
await assert.rejects(createNonEvmReceiveAdapter({ ...receiveArgs, loadState: async () => ({ ...state, tokenAddress: '0x43' }) }), /does not match/);
await assert.rejects(readNonEvmReceiveState({ ...receiveArgs, chainType: 'UNKNOWN' }), /Invalid/);
// Fail closed on public RPC errors: never treat unavailable recipient policy as allowed.
requestFetch = async () => ({ ok: false, status: 429 });
await assert.rejects(readNonEvmReceiveState({ ...receiveArgs, token: '0x42' }), /HTTP 429/);
// Exercise receive policies using RPC-shaped fixtures, including Cairo u256 limb order.
const selector = name => toHex(BigInt(keccak256(stringToHex(name))) & ((1n << 250n) - 1n));
let paused = false, inbound = true;
const calls = new Map([
  [selector('token'), ['0x42']], [selector('shared_decimals'), ['0x6']],
  [selector('get_peer'), ['0x1234', '0x2']], [selector('decimals'), ['0x6']],
  [selector('get_receivable_amount'), ['0x0', '0x0', '0x64', '0x0']],
]);
requestFetch = async (_url, init) => {
  const name = JSON.parse(init.body).params.request.entry_point_selector;
  const result = name === selector('is_paused') ? [paused ? '0x1' : '0x0'] :
    name === selector('get_rate_limit_enabled') ? ['0x0', inbound ? '0x1' : '0x0'] : calls.get(name);
  assert.ok(result, 'Only supported read operations are requested');
  return { ok: true, json: async () => ({ result }) };
};
const starkArgs = { ...receiveArgs, token: '0x42', chainType: 'STARKNET' };
const limited = await readNonEvmReceiveState(starkArgs);
assert.equal(limited.maxAmountLD, '100');
assert.equal(limited.peer, toHex((2n << 128n) + 0x1234n, { size: 32 }));
paused = true;
await assert.rejects(readNonEvmReceiveState(starkArgs), /paused/);
paused = false; inbound = false;
assert.equal((await readNonEvmReceiveState(starkArgs)).maxAmountLD, ((1n << 256n) - 1n).toString());
// Aptos blocked receivers redirect funds: an error must prevent building any send.
requestFetch = async (url, init) => {
  let data;
  if (url.endsWith('/resources')) data = [
    { type: `${peer}::oft_fa::OftImpl`, data: { metadata: { inner: '0x42' } } },
    { type: `${peer}::oft_store::OftStore`, data: { decimal_conversion_rate: '1' } },
    { type: `${peer}::oft_impl_config::Config`, data: { blocklist_enabled: true } },
  ];
  else {
    const fn = JSON.parse(init.body).function.split('::').at(-1);
    data = { token: ['0x42'], shared_decimals: [6], get_peer: [padHex(adapter, { size: 32 })], is_blocklisted: [true] }[fn];
  }
  assert.ok(data);
  return { ok: true, json: async () => data };
};
await assert.rejects(readNonEvmReceiveState({ ...receiveArgs, token: '0x42' }), /redirected/);
requestFetch = (...args) => fetch(...args);
console.log('Non-EVM recipients, single-hop discovery, asset/amount/recipient guards, and RPC failure tests passed.');

if (process.env.LIVE_NON_EVM_OFT !== '1') process.exit(0);
const origin = process.env.BRIDGE_TEST_ORIGIN ?? 'https://earthbound.web3resear.ch';
const get = async path => { const r = await fetch(origin + path); assert.equal(r.ok, true); return r.json(); };
const [{ chains }, { tokens }] = await Promise.all([get('/api/bridge/chains?provider=stargate'), get('/api/bridge/tokens?provider=stargate')]);
const rpc = { ethereum: 'https://ethereum-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com', bsc: 'https://bsc-rpc.publicnode.com' };
const routes = [['ethereum', 'aptos', 'USDe'], ['ethereum', 'aptos', 'WBTC'], ['ethereum', 'aptos', 'sUSDe'],
  ['base', 'aptos', 'KGEN'], ['bsc', 'aptos', 'ELON'], ['ethereum', 'starknet', 'WBTC'], ['ethereum', 'starknet', 'SolvBTC'],
  ['ethereum', 'tron', 'USDe'], ['ethereum', 'tron', 'sUSDe'], ['ethereum', 'tron', 'HARD'], ['ethereum', 'sui', 'WBTC']];
for (const [sourceKey, chainKey, symbol] of routes.filter(([, chain]) => !process.env.DIRECT_OFT_TEST_DESTINATION || chain === process.env.DIRECT_OFT_TEST_DESTINATION)) {
  const client = createPublicClient({ transport: http(rpc[sourceKey], { timeout: 15000, retryCount: 1 }) });
  const srcChain = chains.find(c => c.chainKey === sourceKey), dstChain = chains.find(c => c.chainKey === chainKey);
  const srcToken = tokens.find(t => t.chainKey === sourceKey && t.symbol === symbol);
  const dstToken = tokens.find(t => t.chainKey === chainKey && t.symbol === symbol && !t.address.includes('::asset::'));
  const to = chainKey === 'tron' ? 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' : '0x01' + '11'.repeat(31);
  const amount = symbol === 'WBTC' ? 10000n : 10n * 10n ** BigInt(srcToken.decimals);
  const response = await fetch(origin + '/api/bridge/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    provider: 'stargate', srcChainKey: sourceKey, dstChainKey: chainKey, srcTokenAddress: srcToken.address, dstTokenAddress: dstToken.address,
    srcWalletAddress: from, dstWalletAddress: to, amount: amount.toString(),
    options: { amountType: 'EXACT_SRC_AMOUNT', feeTolerance: { type: 'PERCENT', amount: 0.5 }, dstNativeDropAmount: '0' },
  }) });
  const api = await response.json();
  assert.equal(response.ok, true, JSON.stringify(api));
  assert.ok(api.quotes.length, `${symbol} → ${chainKey} API quote exists`);
  const direct = await buildDirectOftQuote({ metadata: {}, srcChain, dstChain, srcToken, dstToken, amount, from, to,
    discoverPeers: true, fetchDiscoveryQuote: async () => api,
    loadReceiveState: readNonEvmReceiveState,
    read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }),
  });
  const tx = direct.userSteps.at(-1).transaction.encoded;
  const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: tx.data });
  assert.equal(decoded.functionName, 'send');
  assert.equal(decoded.args[0].to, directOftRecipient(dstChain.chainType, to));
  assert.equal(decoded.args[0].amountLD, amount);
  assert.equal(decoded.args[0].composeMsg, '0x');
  assert.equal(decoded.args[0].oftCmd, '0x');
  assert.equal(direct.routeSteps.length, 1);
  assert.ok(BigInt(direct.dstAmount) >= BigInt(api.quotes[0].dstAmount));
  assert.equal(direct.fees.some(f => f.type === 'PRODUCT'), false);
  console.log(JSON.stringify({ route: `${sourceKey} → ${chainKey}`, symbol, direct: direct.dstAmount, api: api.quotes[0].dstAmount, target: tx.to, signed: false }));
}
