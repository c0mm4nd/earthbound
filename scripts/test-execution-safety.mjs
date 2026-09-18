import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { padHex, decodeFunctionData } from 'viem';
const require = createRequire(import.meta.url);
const cache = new Map();
let receipt = { status: '0x1' };
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const m = { exports: {} };
  new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
    module: m, exports: m.exports, window: { ethereum: { request: async () => receipt } },
    require: id => id.startsWith('./') ? load(id.slice(2)) : require(id),
  });
  cache.set(name, m.exports); return m.exports;
}
const { assertExecutionPlan, assertSuccessfulEvmReceipt } = load('execution-safety');
const { waitForInjectedEvmTransactionReceipt } = load('injected-evm');
const { buildCustomOftQuote } = load('custom-oft-quote');
const { buildDirectOftQuote, directOftRecipient, hasReceiveGas } = load('direct-oft');
const { buildLayerZeroExecutorLzReceiveOption, layerZeroOftV2Abi } = load('custom-oft');
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const ethereum = { chainKey: 'ethereum', chainType: 'EVM', chainId: 1, nativeCurrency: { symbol: 'ETH', decimals: 18 } };
const avalanche = { ...ethereum, chainKey: 'avalanche', chainId: 43114 };
const sender = addr(5);
const step = { type: 'TRANSACTION', chainKey: 'ethereum', chainType: 'EVM', transaction: { encoded: { to: addr(3), from: sender, chainId: 1, value: '0', data: '0x' } } };
assertExecutionPlan([step], ethereum, sender);
for (const status of ['reverted', '0x0', undefined]) assert.throws(() => assertSuccessfulEvmReceipt({ status }), /reverted/);
for (const status of ['success', '0x1']) assertSuccessfulEvmReceipt({ status });
receipt = { status: '0x0' }; await assert.rejects(waitForInjectedEvmTransactionReceipt('0xhash'), /reverted/);
receipt = { status: '0x1' }; assert.equal((await waitForInjectedEvmTransactionReceipt('0xhash')).status, '0x1');
for (const patch of [{ to: addr(0) }, { from: addr(9) }, { chainId: 43114 }, { value: '-1' }, { value: (2n ** 256n).toString() }, { data: '0xabc' }])
  assert.throws(() => assertExecutionPlan([{ ...step, transaction: { encoded: { ...step.transaction.encoded, ...patch } } }], ethereum, sender));
for (const bad of [{ ...step, chainKey: 'avalanche' }, { ...step, signerAddress: addr(8) }, { ...step, type: 'UNSUPPORTED' }])
  assert.throws(() => assertExecutionPlan([step, bad], ethereum, sender));
const signature = { type: 'SIGNATURE', chainKey: 'ethereum', chainType: 'EVM', signature: { typedData: { primaryType: 'Permit', types: {}, domain: { chainId: 1, verifyingContract: addr(1) }, message: {} } } };
assertExecutionPlan([signature], ethereum, sender);
signature.signature.typedData.domain.chainId = 43114;
assert.throws(() => assertExecutionPlan([signature], ethereum, sender), /signature domain/);
assert.throws(() => directOftRecipient('EVM', addr(0)), /Invalid/);
assert.throws(() => directOftRecipient('SOLANA', '11111111111111111111111111111111'), /Invalid/);
assert.equal(hasReceiveGas(buildLayerZeroExecutorLzReceiveOption(65000n) + 'ff'), false, 'malformed options tail must not pass');
let wrongPeer = false, wrongToken = false;
const config = { id: 'test', name: 'TEST', symbol: 'TEST', endpointVersion: 'v2', deployments: {
 ethereum: { chainKey: 'ethereum', oftAddress: addr(3), tokenAddress: addr(1), decimals: 18 },
 avalanche: { chainKey: 'avalanche', oftAddress: addr(4), tokenAddress: addr(2), decimals: 6 },
} };
const read = async ({ chain, functionName, args }) => {
 const src = chain.chainKey === 'ethereum';
 switch (functionName) {
  case 'token': return wrongToken ? addr(9) : src ? addr(1) : addr(2);
  case 'peers': return padHex(wrongPeer ? addr(9) : src ? addr(4) : addr(3), { size: 32 });
  case 'sharedDecimals': return 6;
  case 'decimals': return src ? 18 : 6;
  case 'approvalRequired': return true;
  case 'allowance': return 1n;
  case 'enforcedOptions': return buildLayerZeroExecutorLzReceiveOption(65000n);
  case 'quoteOFT': return [{ minAmountLD: 1n, maxAmountLD: 2n ** 256n - 1n }, [], { amountSentLD: args[0].amountLD, amountReceivedLD: args[0].amountLD }];
  case 'quoteSend': return { nativeFee: 100n, lzTokenFee: 0n };
  default: throw new Error(functionName);
 }
};
const input = { config, srcChain: ethereum, dstChain: avalanche, amount: 10n ** 18n, from: sender, to: addr(6), read };
const quote = await buildCustomOftQuote(input);
assert.equal(quote.dstAmount, '1000000', 'custom OFT must convert source to destination precision');
assert.equal(quote.userSteps.length, 3, 'nonzero allowance resets before exact approval');
const send = decodeFunctionData({ abi: layerZeroOftV2Abi, data: quote.userSteps.at(-1).transaction.encoded.data });
assert.equal(send.args[0].minAmountLD, 10n ** 18n);
assert.equal(send.args[0].to, padHex(addr(6), { size: 32 }));
wrongPeer = true; await assert.rejects(buildCustomOftQuote(input), /peers/); wrongPeer = false;
wrongToken = true; await assert.rejects(buildCustomOftQuote(input), /tokens/); wrongToken = false;
await assert.rejects(buildCustomOftQuote({ ...input, amount: (2n ** 64n) * 10n ** 12n }), /integer limit/);
await assert.rejects(buildCustomOftQuote({ ...input, config: { ...config, endpointVersion: 'v1' } }), /Endpoint V2/);
await assert.rejects(buildDirectOftQuote({ metadata: {}, ...input, srcToken: { address: addr(1) }, dstToken: { address: addr(2) }, amount: 0n }), /amount/);
console.log('Execution safety: EVM receipts, full-plan chain/signer/domain checks, zero recipients, options, custom OFT peer/token/decimal/allowance validation and uint64 bounds passed.');
