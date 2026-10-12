import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { StrKey } from '@stellar/stellar-sdk';
import { createLoader } from './helpers/load-ts.mjs';
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58();
const stellar = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 42));
const evm = '0x1111111111111111111111111111111111111111';
const load = createLoader({}, { fetch: async url => {
  if (url.includes('/fees/')) return Response.json([{ finalityThreshold: 2000, minimumFee: '1' }]);
  throw Error(`Unexpected network request ${url}`);
} });
const { CCTP_CHAINS } = load('cctp-catalog');
const { getCctpBridgeQuotes, mergeCctpTokens } = load('cctp-bridge');
const { assertNativeCctpQuote, executeNativeCctp } = load('cctp-native-client');
const { parseExecutionHistory, recoverExecutionHistory, mergeExecutionHistory } = load('execution-history');
const address = domain => domain === 5 ? wallet : domain === 27 ? stellar : domain === 0 ? evm : '0x123';
const hash = domain => domain === 5 ? '1'.repeat(64) : domain === 8 ? wallet : domain === 27 ? 'ab'.repeat(32) : '0x' + '01'.repeat(32);
function request(source, destination) {
  const src = CCTP_CHAINS.find(c => c.domain === source), dst = CCTP_CHAINS.find(c => c.domain === destination);
  return { srcChainKey: src.chainKey, dstChainKey: dst.chainKey, srcTokenAddress: src.usdc, dstTokenAddress: dst.usdc,
    srcWalletAddress: address(source), dstWalletAddress: address(destination), amount: source === 27 ? '10000000' : '1000000' };
}
const history = t => ({ id: 'cctp-native', quoteId: 'q', routeLabel: 'CCTP Standard', srcChainName: 'Source', dstChainName: 'Destination', srcTokenSymbol: 'USDC', dstTokenSymbol: 'USDC', srcAmount: '1 USDC', expectedDstAmount: '0.9999 USDC', destinationAddress: t.recipient, cctpNative: t, phase: 'running', createdAt: 1, updatedAt: 1 });

test('all 30 directed native-family routes bind wallet/token identities and scale Stellar amounts', async () => {
  const domains = [0, 5, 8, 9, 25, 27];
  for (const src of domains) for (const dst of domains) {
    if (src === dst) continue;
    const input = request(src, dst), { quotes } = await getCctpBridgeQuotes(input);
    assert.equal(quotes.length, 1); const q = quotes[0];
    const t = assertNativeCctpQuote(q, input);
    assert.equal(t.amount, '1000000'); assert.equal(t.maxFee, '100');
    assert.equal(q.dstAmount, dst === 27 ? '9999000' : '999900');
    assert.throws(() => assertNativeCctpQuote(q, { ...input, amount: '2' }), /changed/);
    assert.throws(() => assertNativeCctpQuote(q, { ...input, dstTokenAddress: 'USDC.e' }), /changed/);
    assert.throws(() => assertNativeCctpQuote({ ...q, cctpNative: { ...q.cctpNative, quotedAt: 0 } }, input), /changed/);
    assert.ok(mergeCctpTokens([], input.srcChainKey, input.srcTokenAddress).some(t => t.chainKey === input.dstChainKey && t.address === input.dstTokenAddress));
  }
  await assert.rejects(() => getCctpBridgeQuotes({ ...request(27, 0), amount: '10000001' }), /six decimal/);
});

test('muxed Stellar recipient survives quote and validation with its full account ID', async () => {
  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(32, 42), Buffer.alloc(8, 1)]));
  const input = { ...request(0, 27), dstWalletAddress: muxed };
  const { quotes } = await getCctpBridgeQuotes(input);
  assert.equal(assertNativeCctpQuote(quotes[0], input).recipient, muxed);
  assert.equal(load('stellar-address').isStellarCctpRecipient(muxed), true);
  assert.equal(load('stellar-address').isStellarCctpRecipient(muxed.slice(0, -1) + 'A'), false);
});

for (const domain of [5, 8, 9, 25, 27]) test(`native ${domain}: UI execution persists intent/hash, refresh restores it, and claim uses destination family`, async () => {
  const input = request(domain, 0), { quotes } = await getCctpBridgeQuotes(input);
  let t = assertNativeCctpQuote(quotes[0], input), saved;
  let sent = 0, requested = [];
  const step = d => ({ type: 'TRANSACTION', chainType: CCTP_CHAINS.find(c => c.domain === d).family, chainKey: CCTP_CHAINS.find(c => c.domain === d).chainKey, transaction: { encoded: { cctp: true } } });
  await executeNativeCctp(t, 'burn', t.sender, {
    assertContext() {}, persist: next => { saved = JSON.parse(JSON.stringify(next)); },
    request: async (transfer, action) => {
      requested.push(action);
      if (action === 'receipt') return { state: 'confirmed' };
      return { transfer: { ...transfer, ...(domain === 5 ? { eventAccount: wallet } : {}) }, step: step(domain), prerequisite: domain === 27 && action === 'prepare' };
    },
    send: async (_step, submitted) => {
      sent++;
      if (domain === 27 && sent === 1) { assert.equal(saved.state, 'preparing'); return hash(domain); }
      assert.equal(saved.state, 'burn_pending');
      if (domain === 5) assert.equal(saved.eventAccount, wallet);
      submitted(hash(domain)); assert.equal(saved.burnHash, hash(domain)); return hash(domain);
    },
  });
  assert.equal(saved.burnHash, hash(domain));
  if (domain === 27) assert.equal(requested.join(','), 'prepare,receipt,burn');
  const restored = recoverExecutionHistory(parseExecutionHistory(JSON.stringify([history(saved)])))[0];
  assert.equal(restored.phase, 'pending'); assert.equal(restored.cctpNative.burnHash, hash(domain));
  assert.equal(mergeExecutionHistory([history(saved), ...Array.from({ length: 35 }, (_, i) => ({ ...history(saved), id: `other-${i}`, cctpNative: undefined, createdAt: 10 + i }))]).length, 31);
  t = { ...saved, state: 'ready' };
  await executeNativeCctp(t, 'claim', evm, {
    assertContext() {}, persist: next => { saved = next; },
    request: async transfer => ({ transfer, step: step(0) }),
    send: async (s, submitted) => { assert.equal(s.chainType, 'EVM'); assert.equal(saved.state, 'claim_pending'); submitted(hash(0)); return hash(0); },
  });
  assert.equal(saved.claimHash, hash(0));
});

test('storage failure, changed plans, refusal and ambiguous broadcasts never cause a second burn', async () => {
  const input = request(9, 0), { quotes } = await getCctpBridgeQuotes(input), t = assertNativeCctpQuote(quotes[0], input);
  const step = { type: 'TRANSACTION', chainType: 'APTOS', chainKey: 'aptos', transaction: { encoded: {} } };
  let sends = 0, saved;
  const deps = { assertContext() {}, persist: next => { saved = next; }, request: async transfer => ({ transfer, step }),
    send: async (_step, submitted) => { sends++; submitted(hash(9)); throw Error('lost wallet response'); } };
  await assert.rejects(() => executeNativeCctp(t, 'burn', t.sender, { ...deps, persist() { throw Error('storage full'); } }), /storage/);
  await assert.rejects(() => executeNativeCctp(t, 'burn', t.sender, { ...deps, request: async transfer => ({ transfer: { ...transfer, amount: '2000000' }, step }) }), /changed/);
  assert.equal(sends, 0);
  await assert.rejects(() => executeNativeCctp(t, 'burn', t.sender, deps), /lost wallet/);
  assert.equal(saved.burnHash, hash(9)); assert.equal(saved.state, 'burn_pending');
  await assert.rejects(() => executeNativeCctp(saved, 'burn', t.sender, deps), /Recover/); assert.equal(sends, 1);
  await assert.rejects(() => executeNativeCctp(t, 'burn', t.sender, { ...deps, send: async () => { throw Object.assign(Error('rejected'), { code: 4001 }); } }), /rejected/);
  assert.equal(saved.state, 'failed');
});
