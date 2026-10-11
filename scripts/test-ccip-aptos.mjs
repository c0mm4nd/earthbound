import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-ts.mjs';
import { AptosChain, SolanaChain } from '@chainlink/ccip-sdk';
import { Keypair } from '@solana/web3.js';
const load = createLoader();
const { ccipMessageEncoding } = load('ccip-message');
const { ccipAptosPayload, ccipAptosStep, inspectAptosSubmission } = load('ccip-aptos');
const { isCcipAddress, ccipAddressKey } = load('ccip-addresses');
const evm = '0x1111111111111111111111111111111111111111';
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const svm = SolanaChain.buildMessageForDest({ receiver: recipient, tokenAmounts: [{ token: '0xa', amount: 1n }] });
assert.equal(ccipMessageEncoding('APTOS', 'SOLANA', recipient).extraArgs, AptosChain.encodeExtraArgs(svm.extraArgs));
assert.equal(ccipMessageEncoding('APTOS', 'EVM', evm).extraArgs, AptosChain.encodeExtraArgs({ gasLimit: 0n, allowOutOfOrderExecution: true }));
assert.ok(isCcipAddress('APTOS', '0xa'));
assert.equal(ccipAddressKey('0x000A'), ccipAddressKey('0xa'));
for (const address of ['0x0', '0x' + '1'.repeat(65), recipient]) assert.equal(isCcipAddress('APTOS', address), false);
const quote = { srcAmount: '9007199254740993', ccip: { sourceFamily: 'APTOS', destinationFamily: 'EVM', router: '0xabc', sourceToken: '0xdef', destinationSelector: '5009297550715157269', receiver: evm } };
const payload = ccipAptosPayload(quote);
assert.equal(payload.function, '0xabc::router::ccip_send');
assert.equal(payload.arguments[0], '5009297550715157269');
assert.equal(payload.arguments[4][0], '9007199254740993', 'no unsafe Number conversion');
assert.equal(payload.arguments[6], '0xa', 'fee paid in native APT');
assert.equal(payload.arguments[5][0], '0x0', 'primary token store');
assert.equal(ccipAptosStep(quote, 'aptos').transaction.encoded.ccip, true);
assert.throws(() => ccipAptosPayload({ ...quote, srcAmount: (2n ** 64n).toString() }), /Invalid/);
assert.throws(() => ccipAptosPayload({ ...quote, ccip: { ...quote.ccip, router: 'not-a-router' } }), /Invalid/);
const hash = '0x' + 'a'.repeat(64);
const tx = (data, status = 200) => async () => Response.json(data, { status });
assert.equal(await inspectAptosSubmission(hash, tx({ hash, type: 'user_transaction', success: true })), 'confirmed');
assert.equal(await inspectAptosSubmission(hash, tx({ hash, type: 'user_transaction', success: false })), 'failed');
for (const data of [{ hash, type: 'pending_transaction' }, { hash: '0x' + 'b'.repeat(64), type: 'user_transaction', success: true }, { hash, success: true }]) assert.equal(await inspectAptosSubmission(hash, tx(data)), 'pending');
assert.equal(await inspectAptosSubmission(hash, tx({}, 404)), 'pending');
assert.equal(await inspectAptosSubmission(hash, async () => { throw Error('network unavailable'); }), 'pending');
console.log('CCIP Aptos unit: BCS encoding parity, primary stores, native fee, u64 precision, invalid payloads and authoritative source confirmation passed.');
// Wallet execution is tested separately from encoding: wrong networks, account
// switches and user rejection must never submit or retry an Aptos transaction.
let network = 'mainnet', account = '0x1', signCount = 0;
const events = [];
const provider = {
  account: async () => ({ address: account }),
  network: async () => network,
  signAndSubmitTransaction: async value => { signCount++; assert.equal(value.function, payload.function); return { hash }; },
};
const walletLoad = createLoader({}, { window: { aptos: provider } });
const { executeAptosUserSteps } = walletLoad('bridge-wallets');
const step = ccipAptosStep(quote, 'aptos');
assert.equal(await executeAptosUserSteps([step], '0x1', undefined, { beforeSign: () => events.push('before'), submitted: h => events.push(h) }), hash);
assert.deepEqual(events, ['before', hash]);
assert.equal(signCount, 1);
network = 'testnet';
await assert.rejects(() => executeAptosUserSteps([step], '0x1'), /mainnet/);
network = { name: 'mainnet', chainId: 2 };
await assert.rejects(() => executeAptosUserSteps([step], '0x1'), /mainnet/);
network = 'mainnet';
account = '0x2';
await assert.rejects(() => executeAptosUserSteps([step], '0x1'), /wallet changed/i);
account = '0x1';
await assert.rejects(() => executeAptosUserSteps([step], '0x1', undefined, { beforeSign: () => { throw Error('form changed'); } }), /form changed/);
assert.equal(signCount, 1, 'failed preflight never asks the wallet to sign');
provider.signAndSubmitTransaction = async () => { signCount++; throw Error('user rejected'); };
await assert.rejects(() => executeAptosUserSteps([step], '0x1'), /user rejected/);
assert.equal(signCount, 2, 'wallet rejection is not retried');
console.log('CCIP Aptos wallet unit: mainnet, account/form changes, pre-sign guard, submitted hash persistence and rejection passed.');

// Family adapter fixture: a wrapped asset can arrive at an EVM native exit.
// This does not create or advertise a native APT lane in the live catalog.
const { CCIP_WRAPPED_NATIVE, addWrappedNativeRoutes } = load('ccip-wrapped-native');
const { normalizeCcipQuote } = load('ccip');
const { assertCcipQuote } = load('ccip-execution');
const cfg = CCIP_WRAPPED_NATIVE[1];
const aptos = { chainKey: 'aptos', chainId: 1, chainType: 'APTOS', nativeCurrency: { symbol: 'APT', decimals: 8, address: '0xa' }, ccip: { selector: '4741433654826277614', selectorName: 'aptos', router: '0xabc' } };
const eth = { chainKey: 'eth', chainId: 1, chainType: 'EVM', nativeCurrency: { symbol: 'ETH', decimals: 18, address: '0x' + '0'.repeat(40) }, ccip: { selector: cfg.selector, selectorName: 'ethereum', router: cfg.router } };
const fixture = addWrappedNativeRoutes({ chains: [aptos, eth], tokens: [
  { chainKey: 'aptos', address: '0xdef', decimals: 8, ccip: { destinations: [{ chainKey: 'eth', address: cfg.token }] } },
  { chainKey: 'eth', address: cfg.token, decimals: 18, ccip: { destinations: [] } },
] });
const nativeRequest = { srcChainKey: 'aptos', dstChainKey: 'eth', srcTokenAddress: '0xdef', dstTokenAddress: eth.nativeCurrency.address, srcWalletAddress: '0x1', dstWalletAddress: evm, amount: '12345678' };
const nativeQuote = normalizeCcipQuote(fixture, nativeRequest, { ccipFee: '1000' }).quotes[0];
assertCcipQuote(nativeQuote, nativeRequest, aptos);
assert.equal(nativeQuote.dstAmount, '123456780000000000');
assert.equal(nativeQuote.ccip.wrapping.destination, cfg.token);
assert.equal(ccipAptosPayload(nativeQuote).arguments[3][0], '0xdef');
assert.equal(ccipAptosPayload(nativeQuote).arguments[4][0], '12345678');
assert.equal(ccipAptosPayload(nativeQuote).arguments[6], '0xa');
assert.equal(fixture.tokens.filter(t => t.chainKey === 'aptos').length, 1);
console.log('CCIP Aptos native-exit fixture: 8/18 decimal accounting, actual source asset, unchanged APT fee and no invented native APT lane passed.');
