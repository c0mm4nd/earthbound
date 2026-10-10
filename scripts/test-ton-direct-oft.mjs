// All mainnet operations are reads. No wallet signatures or transaction broadcast.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { Address, Cell, beginCell, contractAddress } from '@ton/core';
import { createPublicClient, http, decodeFunctionData } from 'viem';
const require = createRequire(import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/ton-oft.json', import.meta.url)));
let requestFetch;
function load(name) {
  const m = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer, Uint8Array, atob, btoa, AbortSignal,
    fetch: (...args) => requestFetch(...args), setTimeout: cb => setTimeout(cb, 0),
    require: id => id.startsWith('./') ? load(id.slice(2)) : require(id),
  });
  return m.exports;
}
const { readNonEvmReceiveState } = load('direct-oft-receive-state');
const { buildDirectOftQuote, directOftRecipient, supportsDirectOftRoute } = load('direct-oft');
const { createNonEvmReceiveAdapter } = load('direct-oft-receive');
const { layerZeroOftV2Abi } = load('custom-oft');
const { tonAccount } = load('direct-oft-address');
const recipient = Address.parseRaw('0:' + '11'.repeat(32));
assert.equal(tonAccount(recipient.toString({ bounceable: false })), '0x' + '11'.repeat(32));
assert.equal(tonAccount(recipient.toString({ bounceable: true })), '0x' + '11'.repeat(32));
assert.throws(() => tonAccount(recipient.toString({ testOnly: true })), /mainnet/);
assert.throws(() => tonAccount('-1:' + '11'.repeat(32)), /Invalid/);
assert.throws(() => tonAccount('0:' + '00'.repeat(32)), /Invalid/);
assert.throws(() => tonAccount(recipient.toString().slice(0, -1) + 'A'), /valid/);
assert.equal(supportsDirectOftRoute('EVM', 'TON'), true);
assert.equal(supportsDirectOftRoute('TON', 'EVM'), true);
const fromBoc = value => Cell.fromBase64(value);
const boc = value => value.toBoc().toString('base64');
const replaceBits = (cell, start, length, value) => {
  const s = cell.beginParse();
  const prefix = s.loadBits(start); s.skip(length);
  return beginCell().storeBits(prefix).storeUint(value, length).storeSlice(s).endCell();
};
const replaceRef = (cell, index, value) => {
  const b = beginCell().storeBits(cell.bits);
  cell.refs.forEach((ref, i) => b.storeRef(i === index ? value : ref)); return b.endCell();
};
const response = (state, code = '', data = '') => ({ ok: true, result: { '@type': 'raw.fullAccountState', state, code, data, suspended: false, frozen_hash: '' } });
for (const symbol of ['USDe', 'XAUt0']) {
  const fixture = fixtures[symbol];
  const oftAddress = Address.parseRaw(fixture.oft.address), master = Address.parseRaw(fixture.minter.address);
  const original = fromBoc(fixture.oft.data), originalMinter = fromBoc(fixture.minter.data);
  const minterSlice = originalMinter.beginParse();
  const supply = minterSlice.loadCoins(), admin = minterSlice.loadMaybeAddress(), pending = minterSlice.loadMaybeAddress();
  minterSlice.loadAddress(); const walletCode = minterSlice.loadRef(), metadata = minterSlice.loadRef();
  const walletData = (status = 0, owner = recipient, token = master, balance = 0n) => beginCell().storeUint(status, 4).storeCoins(balance).storeAddress(owner).storeAddress(token).endCell();
  const walletAddress = contractAddress(0, { code: walletCode, data: walletData() });
  let oft = original, minter = originalMinter, code = fixture.oft.code, wallet = response('uninitialized'), rpcStatus = 200, requests = 0;
  requestFetch = async url => {
    const u = new URL(url); assert.equal(u.origin, 'https://toncenter.com'); assert.equal(u.pathname, '/api/v2/getAddressInformation');
    requests++;
    let result;
    if (u.searchParams.get('address') === oftAddress.toRawString()) result = response('active', code, boc(oft));
    else if (u.searchParams.get('address') === master.toRawString()) result = response('active', fixture.minter.code, boc(minter));
    else { assert.equal(u.searchParams.get('address'), walletAddress.toRawString()); result = wallet; }
    return { ok: rpcStatus === 200, status: rpcStatus, json: async () => result };
  };
  const args = { chainType: 'TON', address: '0x' + oftAddress.hash.toString('hex'), token: '0x' + master.hash.toString('hex'), remoteEid: 30101, recipient: recipient.toString() };
  const state = await readNonEvmReceiveState(args);
  assert.equal(requests, 3);
  assert.equal(state.decimals, 6); assert.equal(state.sharedDecimals, 6);
  assert.equal(state.maxAmountLD, (2n ** 64n - 1n).toString());
  assert.equal(state.peer, '0x' + '0'.repeat(24) + (symbol === 'USDe' ? '5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' : 'b9c2321bb7d0db468f570d10a424d1cc8efd696c'));
  await assert.rejects(readNonEvmReceiveState({ ...args, remoteEid: 30999 }), /reverse peer/);
  await assert.rejects(readNonEvmReceiveState({ ...args, token: '0x' + '22'.repeat(32) }), /selected asset/);
  code = boc(beginCell().storeUint(1, 8).endCell());
  await assert.rejects(readNonEvmReceiveState(args), /not yet been verified/); code = fixture.oft.code;
  // Actual deployed layout: the first 350 bits are the class header.
  oft = replaceBits(original, 0, 80, 123);
  await assert.rejects(readNonEvmReceiveState(args), /storage class/);
  oft = replaceRef(original, 0, replaceBits(original.refs[0], 350 + 512 + 1, 1, 0));
  await assert.rejects(readNonEvmReceiveState(args), /initialized/);
  oft = replaceRef(original, 1, replaceBits(original.refs[1], 350 + 32, 32, 0));
  await assert.rejects(readNonEvmReceiveState(args), /gas/);
  oft = original;
  // Outbound pause must not masquerade as an inbound pause in these implementations.
  oft = replaceBits(original, 350 + 256, 1, 1);
  await readNonEvmReceiveState(args); oft = original;
  minter = beginCell().storeCoins(supply).storeAddress(admin).storeAddress(pending).storeAddress(recipient).storeRef(walletCode).storeRef(metadata).endCell();
  await assert.rejects(readNonEvmReceiveState(args), /authorized/); minter = originalMinter;
  wallet = response('active', boc(walletCode), boc(walletData(2)));
  await assert.rejects(readNonEvmReceiveState(args), /blocks incoming/);
  wallet = response('active', boc(walletCode), boc(walletData(0, master)));
  await assert.rejects(readNonEvmReceiveState(args), /owner or token/);
  wallet = response('frozen');
  await assert.rejects(readNonEvmReceiveState(args), /frozen/);
  wallet = response('active', boc(walletCode), boc(walletData(1)));
  await readNonEvmReceiveState(args); // Send-only lock still allows receiving.
  wallet = response('active', boc(walletCode), boc(walletData(0, recipient, master, 2n ** 120n - 5n)));
  assert.equal((await readNonEvmReceiveState(args)).maxAmountLD, '4');
  rpcStatus = 404;
  await assert.rejects(readNonEvmReceiveState(args), /HTTP 404/);
  rpcStatus = 429;
  await assert.rejects(readNonEvmReceiveState(args), /HTTP 429/);
  rpcStatus = 200; wallet = response('uninitialized');
  const adapter = await createNonEvmReceiveAdapter({ ...args, selectedToken: { decimals: 6 }, loadState: readNonEvmReceiveState });
  await assert.rejects(adapter.validateReceive(args.recipient, 2n ** 64n), /capacity/);
  await assert.rejects(adapter.validateReceive(master.toString(), 1n), /Recipient changed/);
  await assert.rejects(createNonEvmReceiveAdapter({ ...args, selectedToken: { decimals: 9 }, loadState: readNonEvmReceiveState }), /configuration/);
}
console.log('TON verified code/layout, reciprocal asset links, mint authority, peer, gas configuration, address checksum/network, new and locked Jetton wallets, capacity and RPC failure guards passed.');

if (process.env.LIVE_TON_OFT !== '1') process.exit(0);
requestFetch = fetch;
const origin = process.env.BRIDGE_TEST_ORIGIN ?? 'https://earthbound.web3resear.ch';
const get = async path => { const r = await fetch(origin + path); assert.ok(r.ok); return r.json(); };
const [{ chains }, { tokens }] = await Promise.all([get('/api/bridge/chains?provider=stargate'), get('/api/bridge/tokens?provider=stargate')]);
for (const [key, symbol, rpc] of [
  ['ethereum', 'USDe', 'https://ethereum-rpc.publicnode.com'], ['ethereum', 'ENA', 'https://ethereum-rpc.publicnode.com'],
  ['ethereum', 'XAUt0', 'https://ethereum-rpc.publicnode.com'], ['arbitrum', 'XAUt0', 'https://arbitrum-one-rpc.publicnode.com'],
  ['polygon', 'XAUt0', 'https://polygon-bor-rpc.publicnode.com'], ['avalanche', 'XAUt0', 'https://avalanche-c-chain-rpc.publicnode.com'],
]) {
  if (process.env.TON_TEST_SOURCE && process.env.TON_TEST_SOURCE !== key) continue;
  const srcChain = chains.find(c => c.chainKey === key), dstChain = chains.find(c => c.chainKey === 'ton');
  const srcToken = tokens.find(t => t.chainKey === key && (symbol === 'XAUt0' ? /^xaut0?$/i.test(t.symbol) : t.symbol === symbol));
  const dstToken = tokens.find(t => t.chainKey === 'ton' && t.symbol === symbol);
  assert.ok(srcToken && dstToken, `${key} ${symbol} is in the catalog`);
  const amount = 10n ** BigInt(srcToken.decimals), from = '0x' + '11'.repeat(20), to = recipient.toString({ bounceable: false });
  const payload = { provider: 'stargate', srcChainKey: key, dstChainKey: 'ton', srcTokenAddress: srcToken.address, dstTokenAddress: dstToken.address,
    srcWalletAddress: from, dstWalletAddress: to, amount: amount.toString(), options: { amountType: 'EXACT_SRC_AMOUNT', feeTolerance: { type: 'PERCENT', amount: 0.5 }, dstNativeDropAmount: '0' } };
  console.log(`Checking ${key} → TON ${symbol}`);
  const r = await fetch(origin + '/api/bridge/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const api = await r.json(); assert.ok(r.ok, JSON.stringify(api)); assert.ok(api.quotes.length);
  if (process.env.TON_DEBUG) console.log(JSON.stringify({ routes: api.quotes.map(q => q.routeSteps), targets: api.quotes.map(q => q.userSteps.at(-1)?.transaction?.encoded?.to) }));
  const client = createPublicClient({ transport: http(rpc, { timeout: 15000 }) });
  // Use the real paced module for live calls, not the offline timer override.
  const liveState = async body => {
    const response = await fetch(origin + '/api/bridge/oft-receive-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const quote = await buildDirectOftQuote({ metadata: {}, srcChain, dstChain, srcToken, dstToken, amount, from, to, discoverPeers: true,
    fetchDiscoveryQuote: async () => api, loadReceiveState: liveState,
    read: async ({ address, abi, functionName, args }) => {
      try { return await client.readContract({ address, abi, functionName, args }); }
      catch (error) { if (process.env.TON_DEBUG) console.error(key, functionName, address, error.shortMessage ?? error.message); throw error; }
    },
  });
  const encoded = quote.userSteps.at(-1).transaction.encoded;
  const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: encoded.data });
  assert.equal(decoded.functionName, 'send'); assert.equal(decoded.args[0].dstEid, 30343);
  assert.equal(decoded.args[0].to, directOftRecipient('TON', to));
  assert.equal(decoded.args[0].composeMsg, '0x'); assert.equal(decoded.args[0].oftCmd, '0x');
  assert.equal(quote.dstAmount, '1000000'); assert.ok(BigInt(quote.dstAmount) >= BigInt(api.quotes[0].dstAmount));
  console.log(JSON.stringify({ route: `${key} → TON`, symbol, direct: quote.dstAmount, api: api.quotes[0].dstAmount, target: encoded.to, broadcast: false }));
}
