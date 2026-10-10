import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { Cell, beginCell, Dictionary } from '@ton/core';
import { generateBuildClass } from '@layerzerolabs/lz-ton-sdk-v2';
const require = createRequire(import.meta.url), modules = new Map();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ton-send.json', import.meta.url), 'utf8'));
let now = fixture.recordedAt, mutate = () => {};
class Clock extends Date { static now() { return now; } }
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const m = { exports: {} }; modules.set(name, m);
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer, Uint8Array, atob, btoa, AbortSignal, Date: Clock,
    setTimeout: cb => setTimeout(cb, 0), fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      const row = fixture.records.find(r => r.url === url && r.body?.address === body?.address && r.body?.method === body?.method);
      assert.ok(row, 'Only captured fixed-host read operations may be called');
      const response = structuredClone(row.response); mutate(response, row);
      return { ok: true, json: async () => response };
    }, require: id => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const { quoteTonSend, tonComputeFee } = load('direct-oft-ton-send');
const { createTonSourceAdapter } = load('direct-oft-ton-source');
const { tonOftSendCell } = load('direct-oft-ton-wire');
const request = fixture.request;
const q = await quoteTonSend(request);
assert.equal(q.amountLD, '1000000'); assert.ok(BigInt(q.forward) > BigInt(q.nativeFee)); assert.ok(BigInt(q.value) > BigInt(q.forward));
const payload = Cell.fromBase64(q.payload).beginParse();
assert.equal(payload.loadUint(32), 0x0f8a7ea5); assert.equal(payload.loadUintBig(64), 0n); assert.equal(payload.loadCoins(), 1000000n);
assert.equal(payload.loadAddress().toRawString(), '0:' + q.tokenAddress.slice(2), 'Transfer to minter, which burns and calls OFT');
assert.equal(payload.loadAddress().toRawString(), request.from, 'Refund to sender'); assert.equal(payload.loadMaybeRef(), null);
assert.equal(payload.loadCoins(), BigInt(q.forward)); assert.ok(payload.loadBit()); const md = payload.loadRef(); payload.endParse();
const schema = { OFTSend: { name: 'OFTSend', ...Object.fromEntries(['uint32','address','coins','coins','coins','objRef','cellRef'].map((type, i) => [i, { fieldName: 'OFTSend::' + ['dstEid','to','minAmount','nativeFee','zroFee','extraOptions','composeMessage'][i], fieldType: 'cl::t::' + type }])) } };
const official = generateBuildClass(schema)('OFTSend', { dstEid: 30101n, to: BigInt(request.to), minAmount: 1000000n, nativeFee: BigInt(q.nativeFee), zroFee: 0n, extraOptions: beginCell().endCell(), composeMessage: beginCell().endCell() });
assert.ok(md.equals(official)); assert.ok(md.equals(tonOftSendCell(30101, request.to, 1000000n, BigInt(q.nativeFee))));
const selectedToken = { chainKey: 'ton', address: request.token, decimals: 6, symbol: 'USDe' };
const adapterArgs = { ...request, selectedToken, loadQuote: async () => q };
const adapter = await createTonSourceAdapter(adapterArgs);
const p = { dstEid: 30101, to: request.to, amountLD: 1000000n, minAmountLD: 1000000n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' };
const fee = await adapter.quoteSend(p), steps = await adapter.buildSteps(p, fee);
assert.equal(steps[0].chainType, 'TON'); assert.equal(steps[0].transaction.encoded.network, '-239'); assert.equal(steps[0].transaction.encoded.messages[0].payload, q.payload);
for (const patch of [{ amountLD: 2n }, { to: '0x'+'2'.repeat(64) }, { dstEid: 30110 }, { composeMsg: '0x12' }, { extraOptions: '0x12' }]) await assert.rejects(adapter.quoteSend({ ...p, ...patch }), /parameters changed/);
await assert.rejects(adapter.buildSteps(p, { ...fee, nativeFee: fee.nativeFee + 1n }), /fee changed/);
for (const patch of [{ from: '0:'+'3'.repeat(64) }, { amountLD: '2' }, { payload: q.payload.slice(0, -4)+'AAAA' }, { nativeFee: '0' }, { forward: q.nativeFee }, { validUntil: Math.floor(now/1000)-1 }, { tokenAddress: '0x'+'4'.repeat(64) }, { peer: '0x'+'0'.repeat(64) }])
  await assert.rejects(createTonSourceAdapter({ ...adapterArgs, loadQuote: async () => ({ ...q, ...patch }) }));
now += 181000; await assert.rejects(adapter.quoteSend(p), /expired/); now = fixture.recordedAt;
await assert.rejects(quoteTonSend({ ...request, to: '0x'+'0'.repeat(64) }), /Invalid/);
await assert.rejects(quoteTonSend({ ...request, amountLD: String(1n<<64n) }), /Invalid/);
await assert.rejects(quoteTonSend({ ...request, from: '-1:'+'1'.repeat(64) }), /Invalid/);
const replaceBits = (c, offset, width, value) => { const s=c.beginParse(), prefix=s.loadBits(offset); s.skip(width); return beginCell().storeBits(prefix).storeUint(value,width).storeSlice(s).endCell(); };
const mutateOft = fn => { mutate = (r,row) => { if (new URL(row.url).searchParams.get('address') === '0:'+request.address.slice(2)) r.result.data=fn(Cell.fromBase64(r.result.data)).toBoc().toString('base64'); }; };
mutateOft(c => replaceBits(c, 606, 1, 1)); await assert.rejects(quoteTonSend(request), /paused/);
mutate = r => { if (r.result.sync_utime) r.result.sync_utime -= 1000; }; await assert.rejects(quoteTonSend(request), /stale/);
mutate = (r,row) => { if (new URL(row.url).searchParams.get('address') === q.jettonWallet) r.result.data=replaceBits(Cell.fromBase64(r.result.data),0,4,1).toBoc().toString('base64'); }; await assert.rejects(quoteTonSend(request), /outgoing/);
mutate = (r,row) => { if (new URL(row.url).searchParams.get('address') === q.jettonWallet) { const s=Cell.fromBase64(r.result.data).beginParse();s.loadUint(4);s.loadCoins();r.result.data=beginCell().storeUint(0,4).storeCoins(0).storeSlice(s).endCell().toBoc().toString('base64'); } }; await assert.rejects(quoteTonSend(request), /Jetton balance/);
mutate = (r,row) => { if (new URL(row.url).searchParams.get('address') === request.from) r.result.balance='1'; }; await assert.rejects(quoteTonSend(request), /TON balance/);
mutateOft(c => { const dict = Dictionary.empty(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell());
  const bucketBuild=generateBuildClass({Bucket:{name:'Bucket',...Object.fromEntries(['tokens','capacity','refillPerSecond','lastRefill'].map((n,i)=>[i,{fieldName:'Bucket::'+n,fieldType:'cl::t::uint64'}]))}});
  dict.set(30101n,bucketBuild('Bucket',{tokens:0n,capacity:0n,refillPerSecond:0n,lastRefill:BigInt(Math.floor(now/1000)-60)}));
  const limit=beginCell().storeDictDirect(dict).endCell(); const b=beginCell().storeBits(c.bits);c.refs.forEach((r,i)=>b.storeRef(i===2?beginCell().storeRef(limit).endCell():r));return b.endCell(); }); await assert.rejects(quoteTonSend(request), /rate limit/);
mutate = (r,row) => { if(row.body?.method==='ulnQuote') { const item=r.result.stack[0][1].elements[1].tuple.elements[3].cell;item.bytes=replaceBits(Cell.fromBase64(item.bytes),654,8,1).toBoc().toString('base64'); } }; await assert.rejects(quoteTonSend(request), /cannot quote/);
mutate = () => {};
const cfg=fixture.records.find(r=>r.url.endsWith('/getConfigParam')).response.result.config.bytes;
assert.ok(tonComputeFee(Cell.fromBase64(cfg),200000n)>0n); assert.throws(()=>tonComputeFee(beginCell().endCell(),200000n));
console.log('TON source: official codec, minter burn destination, refunds, fees, expiry, signer/recipient/amount guards, pause, rate limits, locked/empty wallets, chain time and failed ULN quotes passed.');
