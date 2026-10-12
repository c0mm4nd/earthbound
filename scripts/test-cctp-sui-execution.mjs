import assert from 'node:assert/strict';
import { Transaction } from '@mysten/sui/transactions';
import { load, intent, stellar, nativeProof } from './helpers/cctp-native-fixture.mjs';
const b = load('cctp-sui');
const burn = b.cctpSuiBurnTransaction(intent(8));
const data = burn.getData(), calls = data.commands.map(c => c.MoveCall);
assert.deepEqual(calls.map(c => c.function), ['redeem_funds', 'deposit_for_burn', 'burn', 'complete_burn']);
assert.equal(calls[1].package, b.CCTP_SUI.messenger);
assert.equal(calls[2].package, b.CCTP_SUI.handler);
assert.equal(calls[3].typeArguments.length, 2, 'consume the handler ticket atomically');
assert.ok(data.inputs.some(i => i.UnresolvedObject?.objectId === b.CCTP_SUI.treasury));
assert.ok(data.inputs.some(i => i.FundsWithdrawal), 'use the address-balance withdrawal specified by the official guide');
const json = await burn.toJSON();
assert.equal(Transaction.from(json).getData().commands.length, 4);
assert.equal(b.cctpSuiBurnTransaction(intent(8, { destinationDomain: 27, recipient: stellar })).getData().commands.length, 4);
assert.throws(() => b.cctpSuiBurnTransaction(intent(8, { finality: 1000 })), /finality/);
assert.throws(() => b.cctpSuiBurnTransaction(intent(8, { amount: String(2n ** 64n) })), /u64/);
const p = nativeProof(8, '0x123');
const mint = b.cctpSuiClaimTransaction('0x123', '0x456', p.message, p.attestation).getData();
assert.deepEqual(mint.commands.map(c => c.MoveCall.function), ['receive_message', 'prepare_mint', 'mint', 'complete_mint']);
assert.equal(mint.commands[0].MoveCall.package, b.CCTP_SUI.transmitter);
assert.ok(mint.inputs.some(i => i.UnresolvedObject?.objectId === '0x' + '6'.padStart(64, '0')), 'expiry uses Sui clock');
assert.throws(() => b.cctpSuiClaimTransaction('0x789', '0x456', p.message, p.attestation), /recipient/);
console.log('CCTP Sui execution: native balance withdrawal, complete atomic PTBs, mainnet packages/shared objects, clock and recipient binding passed.');

const { wallet } = await import('./helpers/cctp-native-fixture.mjs');
const executor = load('bridge-wallets').executeSuiUserSteps;
const step = { type: 'TRANSACTION', chainType: 'SUI', chainKey: 'sui', transaction: { encoded: { cctp: true, serializedTransaction: json } } };
const events = [];
await assert.rejects(() => executor([step], async input => {
  assert.equal(input.chain, 'sui:mainnet'); events.push('send');
  return { digest: wallet, effects: { status: { status: 'failure', error: 'simulated rejection' } } };
}, { beforeSign: () => events.push('before'), submitted: h => events.push(h) }), /simulated rejection/);
assert.deepEqual(events, ['before', 'send', wallet], 'persist the digest even when effects report failure');
let signed = false;
await assert.rejects(() => executor([step], async () => { signed = true; }, { beforeSign() { throw Error('wallet changed'); } }), /wallet changed/);
assert.equal(signed, false);
console.log('CCTP Sui wallet: explicit mainnet, pre-sign guard and digest persistence before effects checking passed.');

const snapshot = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/cctp-sui-mainnet-state.json', import.meta.url), 'utf8')).result;
const { createCctpMoveMonitor, decodeCctpSuiState } = load('cctp-move-monitor');
assert.equal(decodeCctpSuiState(snapshot).threshold, 2);
const changed = structuredClone(snapshot); changed.data.content.fields.paused = true;
assert.throws(() => decodeCctpSuiState(changed), /unavailable/);
let network = '35834a8a', digest = wallet, status = 'success', emitter = `${b.CCTP_SUI.transmitter}::send_message::MessageSent`, used = false;
const monitor = createCctpMoveMonitor(8, async (_, options) => {
  const { method, params } = JSON.parse(options.body);
  const result = method === 'sui_getChainIdentifier' ? network : method === 'sui_getObject' ? snapshot : method === 'sui_getTransactionBlock'
    ? { digest, effects: { status: { status } }, events: [{ type: emitter, parsedJson: { message: [...Buffer.from(p.message.slice(2), 'hex')] } }] }
    : used ? { data: { content: { type: '0x2::dynamic_field::Field<u256, bool>', fields: { name: params[1].value, value: true } } } } : { error: { code: 'dynamicFieldNotFound' } };
  return Response.json({ result });
});
assert.equal((await monitor.receipt(wallet, true)).message, p.message);
assert.equal((await monitor.attesters()).threshold, 2);
assert.equal(await monitor.nonceUsed('0x' + '01'.repeat(32)), false); used = true;
assert.equal(await monitor.nonceUsed('0x' + '01'.repeat(32)), true);
emitter = '0x123::send_message::MessageSent'; await assert.rejects(() => monitor.receipt(wallet, true), /official Move/);
status = 'failure'; assert.equal((await monitor.receipt(wallet)).state, 'failed');
digest = 'wrong'; await assert.rejects(() => monitor.receipt(wallet), /digest/);
network = 'testnet'; await assert.rejects(() => monitor.attesters(), /mainnet/);
console.log('CCTP Sui monitor: real mainnet state, typed emitter, receipt digest, effects, dynamic nonce table and wrong-network checks passed.');

// Wallets can hold coin objects, address balances, or both. Exact burn amount
// must be split without consuming the remainder as a fee or a second transfer.
const coinIntent = intent(8, { amount: '1000000' });
const objects = b.cctpSuiBurnTransaction(coinIntent, { coins: [{ coinObjectId: '0x1234', balance: '700000' }, { coinObjectId: '0x5678', balance: '500000' }], addressBalance: '0' }).getData();
assert.equal(objects.inputs.some(i => i.FundsWithdrawal), false);
assert.equal(objects.commands[0].$kind, 'MergeCoins');
assert.equal(objects.commands[1].$kind, 'SplitCoins');
assert.equal(objects.commands[2].MoveCall.function, 'deposit_for_burn');
const mixed = b.cctpSuiBurnTransaction(coinIntent, { coins: [{ coinObjectId: '0x1234', balance: '400000' }], addressBalance: '600000' }).getData();
assert.equal(mixed.commands[0].MoveCall.function, 'redeem_funds');
assert.equal(mixed.commands[1].$kind, 'MergeCoins');
assert.equal(mixed.commands[2].$kind, 'SplitCoins');
assert.throws(() => b.cctpSuiBurnTransaction(coinIntent, { coins: [{ coinObjectId: '0x1234', balance: '400000' }], addressBalance: '599999' }), /Insufficient/);
const onlyBalance = b.cctpSuiBurnTransaction(coinIntent, { coins: [], addressBalance: '1000000' }).getData();
assert.equal(onlyBalance.commands[2].$kind, 'TransferObjects', 'consume the empty coin produced by redeem_funds');
console.log('CCTP Sui funding: coin objects, mixed address balance, exact split, insufficient balance and produced-coin ownership passed.');
