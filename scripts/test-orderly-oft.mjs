import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { PublicKey } from '@solana/web3.js';
import { decodeFunctionData, padHex, toHex } from 'viem';
const require = createRequire(import.meta.url);
function load(name, overrides = {}) {
  const m = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports,
    require: id => overrides[id] ?? (id.startsWith('./') ? load(id.slice(2), overrides) : require(id)) });
  return m.exports;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/orderly-runtime.json', import.meta.url), 'utf8'));
const { orderlyAmount, verifyOrderlyEvm, verifyOrderlySolana, ORDERLY_SOLANA_PROGRAM, ORDERLY_SOLANA_MINT } = load('direct-oft-orderly');
const { buildLayerZeroExecutorLzReceiveOption, layerZeroOftV2Abi } = load('custom-oft');
const evmAddress = '0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8';
const implementation = '0xb04d10425e2873ed5c1987a170aee8be0c23bb23';
const readCode = async address => address.toLowerCase() === evmAddress ? fixture.proxy : fixture.implementations[address.toLowerCase()];
const readStorage = async () => padHex(implementation, { size: 32 });
assert.equal(await verifyOrderlyEvm({ chainId: 42161, address: evmAddress, readCode, readStorage }), true);
assert.equal(await verifyOrderlyEvm({ chainId: 999, address: evmAddress, readCode, readStorage }), false);
await assert.rejects(verifyOrderlyEvm({ chainId: 42161, address: evmAddress }), /cannot be verified/);
await assert.rejects(verifyOrderlyEvm({ chainId: 42161, address: evmAddress, readCode: async () => '0x00', readStorage }), /proxy implementation/);
await assert.rejects(verifyOrderlyEvm({ chainId: 42161, address: evmAddress, readCode, readStorage: async () => padHex('0x99', { size: 32 }) }), /implementation has changed/);
const program = new PublicKey(ORDERLY_SOLANA_PROGRAM), programData = new PublicKey('84iYLUvVSzgdGyn3js3RnrfiCwLmfYwWLtHXr6daAoM');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const raw = { executable: true, owner: loader, data: Buffer.concat([Buffer.from([2,0,0,0]), programData.toBuffer()]) };
const header = Buffer.alloc(45); header.writeUInt32LE(3); header.writeBigUInt64LE(302587384n, 4);
const connection = { getAccountInfo: async (key, options) => { assert.equal(key.toBase58(), programData.toBase58()); assert.equal(options.dataSlice.length, 45); return { owner: loader, data: header }; } };
assert.equal(await verifyOrderlySolana(connection, program, raw), true);
header.writeBigUInt64LE(302587385n, 4);
await assert.rejects(verifyOrderlySolana(connection, program, raw), /upgraded/);
header.writeBigUInt64LE(302587384n, 4);
await assert.rejects(verifyOrderlySolana(connection, program, { ...raw, executable: false }), /Invalid/);
const u64 = (1n << 64n) - 1n;
assert.equal(orderlyAmount(100n * 10n ** 18n, 18, 10), 100n * 10n ** 10n);
assert.equal(orderlyAmount(1n, 10, 18), 10n ** 8n);
assert.equal(orderlyAmount(u64, 10, 18), u64 * 10n ** 8n);
assert.equal(orderlyAmount(u64 * 10n ** 8n, 18, 10), u64);
assert.throws(() => orderlyAmount((u64 + 1n) * 10n ** 8n, 18, 10), /destination amount/);
assert.throws(() => orderlyAmount(u64 + 1n, 10, 18), /source amount/);
assert.throws(() => orderlyAmount(1n << 256n, 18, 18), /source amount/);
assert.throws(() => orderlyAmount(-1n, 18, 10), /source amount/);
assert.throws(() => orderlyAmount(1n, 6, 10), /decimals/);
const store = new PublicKey('Efvf2QfcPAJc8XCd1MV1MN1JLNDZRKj2ZbJ3xg6pAf7');
const options = buildLayerZeroExecutorLzReceiveOption(200000n);
let encoding = 'orderly-u256', receiveChecked, sent;
const solAdapter = () => ({ addressBytes32: toHex(store.toBytes()), tokenAddress: ORDERLY_SOLANA_MINT, decimals: 10, sharedDecimals: 10,
  amountEncoding: encoding, peer: padHex(evmAddress, { size: 32 }), enforcedOptions: options,
  validateReceive: async (_, amount) => { receiveChecked = amount; },
  quoteOft: async p => ({ minAmountLD: 0n, maxAmountLD: u64, amountSentLD: p.amountLD, amountReceivedLD: p.amountLD }),
  quoteSend: async () => ({ nativeFee: 100n, lzTokenFee: 0n }),
  buildSteps: async p => { sent = p; return []; },
});
const { buildDirectOftQuote } = load('direct-oft', { './direct-oft-solana': { createSolanaOftAdapter: async () => solAdapter() } });
const evm = { chainId: 42161, chainKey: 'arbitrum', chainType: 'EVM', nativeCurrency: { symbol: 'ETH', decimals: 18 } };
const sol = { chainKey: 'solana', chainType: 'SOLANA', nativeCurrency: { symbol: 'SOL', decimals: 9 } };
const et = { address: evmAddress, decimals: 18, symbol: 'ORDER' }, st = { address: ORDERLY_SOLANA_MINT, decimals: 10, symbol: 'ORDER' };
const metadata = { ORDER: [{ endpointVersion: 'v2', deployments: { arbitrum: { address: evmAddress }, solana: { address: ORDERLY_SOLANA_MINT } } }] };
const read = async r => {
  switch (r.functionName) {
    case 'token': return evmAddress;
    case 'peers': return toHex(store.toBytes());
    case 'sharedDecimals': case 'decimals': return 18;
    case 'approvalRequired': case 'onlyTrustCaller': return false;
    case 'decimalConversionRate': return 1n;
    case 'enforcedOptions': return options;
    case 'quoteOFT': return [{ minAmountLD: 0n, maxAmountLD: (1n << 256n) - 1n }, [], { amountSentLD: r.args[0].amountLD, amountReceivedLD: r.args[0].amountLD }];
    case 'quoteSend': return { nativeFee: 100n, lzTokenFee: 0n };
    default: throw Error(r.functionName);
  }
};
const args = { metadata, srcChain: evm, dstChain: sol, srcToken: et, dstToken: st, amount: 100n * 10n ** 18n + 123n,
  from: '0x1111111111111111111111111111111111111111', to: 'FLAcC5cQWtiKQunbP81HSCJagmTAMg6gzh84J2Db1WzS', read,
  readEvmCode: (_, address) => readCode(address), readEvmStorage: readStorage };
const q = await buildDirectOftQuote(args);
assert.equal(q.dstAmount, '1000000000000'); assert.equal(receiveChecked, 100n * 10n ** 10n);
const p = decodeFunctionData({ abi: layerZeroOftV2Abi, data: q.userSteps[0].transaction.encoded.data }).args[0];
assert.equal(p.amountLD, 100n * 10n ** 18n, 'EVM dust stays in the wallet');
assert.equal(p.minAmountLD, p.amountLD); assert.equal(q.fees.length, 1);
const reverse = await buildDirectOftQuote({ ...args, srcChain: sol, dstChain: evm, srcToken: st, dstToken: et, from: args.to, to: args.from, amount: 100n * 10n ** 10n });
assert.equal(reverse.dstAmount, '100000000000000000000'); assert.equal(sent.amountLD, 100n * 10n ** 10n);
encoding = undefined; await assert.rejects(buildDirectOftQuote(args), /encodings do not match/); encoding = 'orderly-u256';
await assert.rejects(buildDirectOftQuote({ ...args, amount: (u64 + 1n) * 10n ** 8n }), /integer limit/);
await assert.rejects(buildDirectOftQuote({ ...args, amount: 99999999n }), /transfer limits/);
await assert.rejects(buildDirectOftQuote({ ...args, read: r => r.functionName === 'decimalConversionRate' ? Promise.resolve(10n) : read(r) }), /configuration changed/);
await assert.rejects(buildDirectOftQuote({ ...args, read: r => r.functionName === 'onlyTrustCaller' ? Promise.resolve(true) : r.functionName === 'trustAddress' ? Promise.resolve(false) : read(r) }), /approved callers/);
// EVM-to-EVM uses a 256-bit wire amount, without the standard uint64 cap.
const base = { ...evm, chainId: 8453, chainKey: 'base' };
const eq = await buildDirectOftQuote({ ...args, dstChain: base, dstToken: et, to: args.from,
  metadata: { ORDER: [{ endpointVersion: 'v2', deployments: { arbitrum: { address: evmAddress }, base: { address: evmAddress } } }] },
  read: r => r.functionName === 'peers' ? Promise.resolve(padHex(evmAddress, { size: 32 })) : read(r),
});
assert.equal(eq.dstAmount, args.amount.toString());
console.log('ORDER OFT: proxy/runtime and Solana upgrade pinning, codec matching, 18↔10 decimals, retained dust, u64/uint256 bounds, caller restrictions and EVM↔EVM amounts passed.');
