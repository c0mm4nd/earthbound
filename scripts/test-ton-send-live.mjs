// Live mainnet reads and local TVM execution only. No key, signing or broadcast.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createPublicClient, http, fallback } from 'viem';
import * as evmChains from 'viem/chains';
import { Address, Cell } from '@ton/core';
import { Blockchain, RemoteBlockchainStorage, internal } from '@ton/sandbox';
import { decodeClass } from '@layerzerolabs/lz-ton-sdk-v2';
if (process.env.LIVE_TON_SEND !== '1') { console.log('Skipped TON bidirectional reads / TVM checks. Set LIVE_TON_SEND=1.'); process.exit(0); }
const require = createRequire(import.meta.url), modules = new Map(), records = [];
let record = false;
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const m = { exports: {} }; modules.set(name, m);
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer, Uint8Array, atob, btoa, AbortSignal, setTimeout,
    fetch: async (url, options) => { const r = await fetch(url, options);
      if (record && String(url).startsWith('https://toncenter.com/')) records.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : undefined, response: await r.clone().json() });
      return r; },
    require: id => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ton-send-live.json', import.meta.url), 'utf8'));
const evmWallet = '0x1111111111111111111111111111111111111111';
const ton = fixture.chains.find(c => c.chainKey === 'ton');
let rpcQueue = Promise.resolve();
function rpc(method, body) {
  const p = rpcQueue.catch(() => {}).then(async () => {
    for (let n = 0; n < 4; n++) {
      await new Promise(r => setTimeout(r, 1600 + n * 1000));
      const r = await fetch('https://toncenter.com/api/v2/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const j = await r.json(); if (j.ok) return j.result;
      if (j.code !== 429) throw Error(JSON.stringify(j));
    }
    throw Error('TON RPC rate limit');
  }); rpcQueue = p; return p;
}
const snapshots = new Map();
const remote = { getLastBlockSeqno: async () => 0, getAccount: async (_, address) => {
  const key = address.toRawString();
  if (!snapshots.has(key)) snapshots.set(key, await rpc('getAddressInformation', { address: key }));
  const a = snapshots.get(key);
  if (a.state !== 'active' && a.state !== 'uninitialized') throw Error('Frozen TON simulation account');
  return { state: a.state === 'active' ? { type: 'active', state: { code: Cell.fromBase64(a.code), data: Cell.fromBase64(a.data) } } : { type: 'uninit' }, balance: BigInt(a.balance) };
} };
let config;
function events(cell, found = []) {
  if (cell.bits.length >= 606 && cell.beginParse().loadUintBig(80) === BigInt('0x6576656e74')) {
    const topic = cell.beginParse().skip(350).loadUintBig(256);
    found.push({ topic: Buffer.from(topic.toString(16), 'hex').toString(), body: cell.refs[0] });
  }
  for (const ref of cell.refs) events(ref, found);
  return found;
}
const results = [];
for (const c of fixture.cases) {
  if (process.env.TON_SEND_CASE && process.env.TON_SEND_CASE !== `${c.symbol}:${c.key}`) continue;
  const evm = fixture.chains.find(x => x.chainKey === c.key);
  const tt = fixture.tokens.find(t => t.chainKey === 'ton' && t.symbol === c.symbol);
  const et = fixture.tokens.find(t => t.chainKey === c.key && (c.symbol === 'XAUt0' ? /^xaut0?$/i.test(t.symbol) : t.symbol === c.symbol));
  const client = createPublicClient({ transport: fallback([...new Set([...(load('rpc-config').DEFAULT_RPC_URLS[c.key] || []), ...(c.key === 'ethereum' ? ['https://ethereum-rpc.publicnode.com'] : Object.values(evmChains).find(x => x.id === evm.chainId).rpcUrls.default.http)])].map(url => http(url, { timeout: 20000, retryCount: 0 }))) });
  const base = { metadata: { mesh: [{ endpointVersion: 'v2', deployments: { ton: { address: c.tonOft, innerTokenAddress: tt.address }, [c.key]: { address: c.evmOft, innerTokenAddress: et.address } } }] },
    read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }),
    loadReceiveState: load('direct-oft-receive-state').readNonEvmReceiveState,
    loadTonSendQuote: load('direct-oft-ton-send').quoteTonSend,
    fetchDiscoveryQuote: async () => { throw Error('API fee routes must not be used'); },
  };
  record = Boolean(process.env.TON_CAPTURE && c.symbol === 'USDe');
  const q = await load('direct-oft').buildDirectOftQuote({ ...base, srcChain: ton, dstChain: evm, srcToken: tt, dstToken: et, amount: 1000000n, from: c.holder, to: evmWallet, simulate: true });
  record = false;
  assert.equal(q.dstAmount, String(10n ** BigInt(et.decimals)));
  assert.equal(q.userSteps.length, 1); assert.equal(q.fees.length, 1);
  if (process.env.TON_CAPTURE && c.symbol === 'USDe') writeFileSync(process.env.TON_CAPTURE, JSON.stringify({ recordedAt: Date.now(), request: { address: '0x' + c.tonOft.slice(2), token: tt.address, remoteEid: 30101, from: c.holder, to: '0x' + '0'.repeat(24) + evmWallet.slice(2), amountLD: '1000000', checkBalance: true }, records }, null, 2) + '\n');
  const reverse = await load('direct-oft').buildDirectOftQuote({ ...base, srcChain: evm, dstChain: ton, srcToken: et, dstToken: tt, amount: 10n ** BigInt(et.decimals), from: c.evmHolder || evmWallet, to: c.holder });
  assert.equal(reverse.dstAmount, '1000000');
  if (c.evmHolder) {
    assert.equal(reverse.userSteps.length, 1, 'Public EVM holder must already have sufficient approval');
    const tx = reverse.userSteps[0].transaction.encoded;
    await client.call({ account: c.evmHolder, to: tx.to, data: tx.data, value: BigInt(tx.value),
      stateOverride: [{ address: c.evmHolder, balance: 10n ** 22n }] });
  }
  if (!config) config = Cell.fromBase64((await rpc('getConfigAll', {})).config.bytes);
  const chain = await Blockchain.create({ config, storage: new RemoteBlockchainStorage(remote, 0) });
  chain.now = Math.floor(Date.now() / 1000);
  chain.verbosity = { print: false, blockchainLogs: false, vmLogs: 'none', debugLogs: false };
  const message = q.userSteps[0].transaction.encoded.messages[0];
  const simulated = await chain.sendMessage(internal({ from: Address.parse(c.holder), to: Address.parse(message.address), value: BigInt(message.amount), body: Cell.fromBase64(message.payload) }));
  const emitted = simulated.transactions.flatMap(t => [...t.outMessages.values()].flatMap(m => events(m.body)));
  assert.ok(emitted.some(e => e.topic === 'EVENT::OFTSentSucceed'), 'TON send callback must succeed');
  assert.ok(!emitted.some(e => e.topic === 'EVENT::OFTSentFailed'), 'TON must not refund a failed bridge');
  const packet = emitted.find(e => e.topic === 'Channel::event::PACKET_SENT');
  assert.ok(packet, 'TON channel must emit a packet');
  const encoded = decodeClass('md::PacketSent', packet.body).packetEncoded;
  // PacketV1 header 81 bytes + GUID 32 bytes, followed by the 40-byte OFT payload.
  let bits = encoded.beginParse(), data = Buffer.alloc(0);
  while (true) { assert.equal(bits.remainingBits % 8, 0); data = Buffer.concat([data, bits.loadBuffer(bits.remainingBits / 8)]); if (!bits.remainingRefs) break; bits = bits.loadRef().beginParse(); }
  assert.equal(data.length, 153); assert.equal(data.subarray(113, 145).toString('hex'), '0'.repeat(24) + evmWallet.slice(2)); assert.equal(data.readBigUInt64BE(145), 1000000n);
  const row = { symbol: c.symbol, pair: `ton ↔ ${c.key}`, amount: '1 token', quotes: 'both passed', tonSendSimulation: 'passed', evmSendSimulation: c.evmHolder ? 'passed; native gas balance override only' : 'not checked', packetBytes: 153, signedOrBroadcast: false };
  results.push(row); console.log(row);
  if (process.env.TON_RESULTS) writeFileSync(process.env.TON_RESULTS, JSON.stringify(results, null, 2) + '\n');
}
