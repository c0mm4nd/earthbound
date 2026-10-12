import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createLoader } from './helpers/load-ts.mjs';
let allowanceAvailable = true;
const load = createLoader({}, { fetch: async url => {
  if (url.endsWith('/allowance')) return Response.json(allowanceAvailable ? { allowance: 100000 } : {}, { status: allowanceAvailable ? 200 : 429 });
  if (url.includes('/fees/0/6')) return Response.json([{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }]);
  throw Error('Unexpected external request');
} });
const { getCctpBridgeQuotes, mergeCctpTokens, cctpBridgeChains } = load('cctp-bridge');
const { cctpEvm, assertCctpQuote } = load('cctp-evm');
const request = { srcChainKey: 'ethereum', dstChainKey: 'base', srcTokenAddress: cctpEvm(0).usdc, dstTokenAddress: cctpEvm(6).usdc,
  srcWalletAddress: '0x' + '1'.repeat(40), dstWalletAddress: '0x' + '2'.repeat(40), amount: '100000000' };

test('CCTP quotes bind source/destination wallet, native USDC, mode and fresh amount', async () => {
  const { quotes } = await getCctpBridgeQuotes(request);
  assert.equal(quotes.length, 2);
  for (const q of quotes) assertCctpQuote(q, request);
  assert.equal(quotes[0].dstAmountMin, '99990000');
  assert.equal(quotes[1].dstAmountMin, '100000000');
  for (const patch of [{ srcWalletAddress: request.dstWalletAddress }, { amount: '1' }, { dstTokenAddress: request.srcTokenAddress }, { dstChainKey: 'arbitrum' }]) {
    assert.throws(() => assertCctpQuote(quotes[0], { ...request, ...patch }));
  }
  assert.throws(() => assertCctpQuote({ ...quotes[0], cctp: { ...quotes[0].cctp, quotedAt: 0 } }, request));
  allowanceAvailable = false;
  assert.equal((await getCctpBridgeQuotes(request)).quotes.length, 1, 'Standard remains available when Fast allowance is unknown');
});

test('native USDC catalog preserves provider metadata, direction and case-sensitive non-EVM tokens', () => {
  const original = { chainKey: 'ethereum', address: cctpEvm(0).usdc, decimals: 6, symbol: 'USDC', name: 'USDC',
    bridgeProviders: ['layerzero', 'ccip'], ccip: { destinations: [{ chainKey: 'base', address: cctpEvm(6).usdc }] } };
  const tokens = mergeCctpTokens([original]);
  const merged = tokens.find(t => t.chainKey === 'ethereum');
  assert.equal(merged.bridgeProviders.join(','), 'layerzero,ccip,cctp');
  assert.equal(merged.ccip.destinations.length, 1);
  assert.equal(mergeCctpTokens([], 'ethereum', 'USDC.e').length, 0);
  assert.ok(mergeCctpTokens([], 'ethereum', cctpEvm(0).usdc).every(t => t.chainKey !== 'ethereum'));
  const solana = mergeCctpTokens([{ chainKey: 'solana', address: 'AbC' }, { chainKey: 'solana', address: 'abc' }], 'solana', 'AbC');
  assert.equal(solana.length, 2);
  assert.ok(cctpBridgeChains().filter(c => c.chainType === 'EVM').every(c => c.chainId > 0));
  assert.equal(cctpBridgeChains().filter(c => c.chainType !== 'EVM').map(c => c.chainType).sort().join(','), 'APTOS,SOLANA,STARKNET,STELLAR,SUI');
});

function route(name) {
  const commonJsModule = { exports: {} };
  const source = readFileSync(new URL(`../src/app/api/bridge/${name}/route.ts`, import.meta.url), 'utf8');
  new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText).runInNewContext({ module: commonJsModule, exports: commonJsModule.exports, URL,
    require: id => id === 'next/server' ? { NextResponse: { json: (...args) => Response.json(...args) } } : {},
  });
  return commonJsModule.exports;
}
test('CCTP never falls through to another provider execution or tracking API', async () => {
  for (const name of ['build-user-steps', 'submit-signature']) {
    for (const body of [{ provider: 'cctp' }, { quoteId: 'cctp-test' }]) {
      assert.equal((await route(name).POST(new Request('https://app.test/api', { method: 'POST', body: JSON.stringify(body) }))).status, 400);
    }
  }
  const r = await route('status/[quoteId]').GET(new Request('https://app.test/api?provider=cctp'), { params: Promise.resolve({ quoteId: 'cctp-test' }) });
  assert.equal(r.status, 400);
});
