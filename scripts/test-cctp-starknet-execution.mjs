import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, intent, stellar, nativeProof } from './helpers/cctp-native-fixture.mjs';
const b = load('cctp-starknet');
const abi = JSON.parse(readFileSync(new URL('./fixtures/cctp-starknet-abi.json', import.meta.url), 'utf8')).abi;
const signature = abi.flatMap(i => i.items).find(i => i.name === 'deposit_for_burn');
const t = intent(25, { amount: String(2n ** 200n + 123n) }), calls = b.cctpStarknetBurnCalls(t);
assert.equal(calls.length, 2, 'approve and burn belong to one account multicall');
assert.equal(calls[0].entrypoint, 'approve');
assert.equal(calls[1].contractAddress, b.CCTP_STARKNET.messenger);
let offset = 0; const decoded = {};
for (const input of signature.inputs) {
  let value = BigInt(calls[1].calldata[offset++]);
  if (input.type === 'core::integer::u256') value += BigInt(calls[1].calldata[offset++]) * 2n ** 128n;
  decoded[input.name] = value;
}
assert.equal(offset, calls[1].calldata.length, 'consume precisely the deployed Cairo ABI');
assert.equal(decoded.amount, BigInt(t.amount));
assert.equal(decoded.mint_recipient, BigInt(t.recipient));
assert.equal(decoded.max_fee, 10000n);
assert.equal(decoded.destination_caller, 0n);
assert.equal(b.cctpStarknetBurnCalls(intent(25, { destinationDomain: 27, recipient: stellar }))[1].entrypoint, 'deposit_for_burn_with_hook');
function decodeBytes(values) {
  const count = Number(values[0]), chunks = values.slice(1, count + 1).map(v => BigInt(v).toString(16).padStart(62, '0'));
  const tailSize = Number(values[count + 2]);
  if (tailSize) chunks.push(BigInt(values[count + 1]).toString(16).padStart(tailSize * 2, '0'));
  return { hex: '0x' + chunks.join(''), length: count + 3 };
}
for (const size of [0, 1, 30, 31, 32, 62, 376]) {
  const bytes = Buffer.alloc(size, 255);
  assert.equal(decodeBytes(b.cctpCairoBytes(bytes)).hex, '0x' + bytes.toString('hex'));
}
const p = nativeProof(25, '0x123'), claim = b.cctpStarknetClaimCall('0x123', p.message, p.attestation);
const msg = decodeBytes(claim.calldata);
assert.equal(msg.hex, p.message);
assert.equal(decodeBytes(claim.calldata.slice(msg.length)).hex, p.attestation);
assert.equal(claim.contractAddress.toLowerCase(), '0x02ebb5777b6dd8b26ea11d68fdf1d2c85cd2099335328be845a28c77a8aef183');
assert.throws(() => b.cctpStarknetClaimCall('0x456', p.message, p.attestation), /recipient/);
assert.throws(() => b.cctpCairoUint256(2n ** 256n), /u256/);
console.log('CCTP Starknet execution: deployed ABI layout, atomic approval/burn, exact u256 limbs, Cairo ByteArray boundaries and receive encoding passed.');

const { createLoader } = await import('./helpers/load-ts.mjs');
let network = '0x534e5f4d41494e', active = '0x123', submits = 0;
const events = [], hash = '0x' + '01'.repeat(32);
const provider = { get selectedAddress() { return active; }, request: async () => network,
  account: { get address() { return active; }, execute: async received => { submits++; assert.equal(received.length, 2); return { transaction_hash: hash }; } } };
const executor = createLoader({}, { window: { starknet: provider } })('bridge-wallets').executeStarknetUserSteps;
const step = { type: 'TRANSACTION', chainType: 'STARKNET', chainKey: 'starknet', transaction: { encoded: { calls, cctp: true } } };
assert.equal(await executor([step], active, undefined, { beforeSign: () => events.push('before'), submitted: h => events.push(h) }), hash);
assert.deepEqual(events, ['before', hash]);
network = 'SN_SEPOLIA'; await assert.rejects(() => executor([step], active), /mainnet/);
network = 'SN_MAIN'; active = '0x456'; await assert.rejects(() => executor([step], '0x123'), /wallet changed/i);
active = '0x123'; await assert.rejects(() => executor([step], active, undefined, { beforeSign() { throw Error('storage failed'); } }), /storage/);
assert.equal(submits, 1);
console.log('CCTP Starknet wallet: mainnet/account checks, durable pre-sign guard and submitted hash callback passed.');

const { keccak256, stringToHex, toHex } = await import('viem');
const select = name => toHex(BigInt(keccak256(stringToHex(name))) & (2n ** 250n - 1n));
let receiptStatus = 'SUCCEEDED', receiptHash = hash, emitter = b.CCTP_STARKNET.transmitter, rpcNetwork = '0x534e5f4d41494e';
const views = Object.fromEntries(Object.entries({ get_local_domain: ['0x19'], get_version: ['0x1'], get_signature_threshold: ['0x1'], get_enabled_attesters: ['0x1', '0x123'], is_nonce_used: ['0x1'] }).map(([k, v]) => [select(k), v]));
const monitor = load('cctp-starknet-monitor').createCctpStarknetMonitor(async (_, options) => {
  const { method, params } = JSON.parse(options.body);
  if (receiptStatus === 'missing' && method === 'starknet_getTransactionReceipt') return Response.json({ error: { code: 29 } });
  return Response.json({ result: method === 'starknet_chainId' ? rpcNetwork : method === 'starknet_call' ? views[params.request.entry_point_selector] : {
    transaction_hash: receiptHash, execution_status: receiptStatus, finality_status: 'ACCEPTED_ON_L2',
    events: [{ from_address: emitter, keys: [select('MessageSent')], data: b.cctpCairoBytes(Buffer.from(p.message.slice(2), 'hex')) }],
  } });
});
assert.equal((await monitor.attesters()).threshold, 1);
assert.equal(await monitor.nonceUsed('0x' + '01'.repeat(32)), true);
assert.equal((await monitor.receipt(hash, true)).message, p.message);
emitter = '0x123'; await assert.rejects(() => monitor.receipt(hash, true), /Circle/);
receiptStatus = 'REVERTED'; assert.equal((await monitor.receipt(hash)).state, 'failed');
receiptStatus = 'missing'; assert.equal((await monitor.receipt(hash)).state, 'pending');
receiptStatus = 'SUCCEEDED'; receiptHash = '0x123'; await assert.rejects(() => monitor.receipt(hash), /hash/);
rpcNetwork = 'SN_SEPOLIA'; await assert.rejects(() => monitor.attesters(), /mainnet/);
console.log('CCTP Starknet monitor: Cairo event bytes, emitter/hash identity, finality, pending/reverted states and onchain attesters/nonces passed.');
