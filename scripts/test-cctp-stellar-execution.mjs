import assert from 'node:assert/strict';
import { scValToNative, StrKey, Account, MuxedAccount } from '@stellar/stellar-sdk';
import { load, intent, stellar, nativeProof } from './helpers/cctp-native-fixture.mjs';
const b = load('cctp-stellar'), n = load('cctp-native');
const ops = b.cctpStellarBurnOperations(intent(27), 123456);
function invocation(op) { return op.body.invokeHostFunctionOp.hostFunction.invokeContract; }
const approve = invocation(ops.approve), burn = invocation(ops.burn);
assert.equal(approve.functionName.toString(), 'approve');
assert.equal(scValToNative(approve.args[2]), 90071992547409930n);
assert.equal(scValToNative(approve.args[3]), 123456);
assert.equal(burn.functionName.toString(), 'deposit_for_burn');
assert.equal(scValToNative(burn.args[1]), 90071992547409930n, 'six-to-seven decimal burn scaling');
assert.equal(scValToNative(burn.args[6]), 100000n, 'maxFee must also scale to Stellar subunits');
assert.equal(scValToNative(burn.args[7]), 2000);
assert.throws(() => b.cctpStellarBurnOperations(intent(27), -1), /expiration/);
assert.throws(() => b.cctpStellarBurnOperations(intent(27, { sender: n.CCTP_STELLAR.forwarder }), 1), /account wallet/);
const muxed = new MuxedAccount(new Account(stellar, '0'), '18446744073709551615').accountId();
for (const recipient of [stellar, n.CCTP_STELLAR.forwarder, muxed]) {
  const target = n.cctpMintTarget(27, recipient);
  const hook = Buffer.from(target.hook.slice(2), 'hex');
  assert.equal(hook.readUInt32BE(24), 0);
  assert.equal(hook.readUInt32BE(28), Buffer.byteLength(recipient));
  assert.equal(hook.subarray(32).toString(), recipient);
  assert.equal(target.destinationCaller, target.mintRecipient);
  assert.equal(StrKey.encodeContract(Buffer.from(target.mintRecipient.slice(2), 'hex')), n.CCTP_STELLAR.forwarder);
  const p = nativeProof(27, recipient);
  assert.equal(invocation(b.cctpStellarClaimOperation(recipient, p.message, p.attestation)).functionName.toString(), 'mint_and_forward');
  assert.throws(() => b.cctpStellarClaimOperation(recipient, p.message.slice(0, -2) + '00', p.attestation), /recipient/);
}
console.log('CCTP Stellar execution: exact allowance/fee scaling, typed G/C/M hook, forced official forwarder and atomic mint-and-forward encoding passed.');

const { Keypair, TransactionBuilder, Networks } = await import('@stellar/stellar-sdk');
const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42)), account = key.publicKey();
const transaction = new TransactionBuilder(new Account(account, '1'), { fee: '100', networkPassphrase: Networks.PUBLIC })
  .addOperation(b.cctpStellarBurnOperations(intent(27, { sender: account }), 123456).burn).setTimeout(60).build();
const encoded = transaction.toXDR(), hash = Buffer.from(transaction.hash()).toString('hex'), events = [];
let network = Networks.PUBLIC, mutate = false, broadcasts = 0;
const wallet = { getAddress: async () => ({ address: account }), getNetworkDetails: async () => ({ networkPassphrase: network }),
  signTransaction: async (xdr, options) => {
    assert.equal(options.address, account); events.push('sign');
    const tx = mutate ? new TransactionBuilder(new Account(account, '1'), { fee: '999', networkPassphrase: Networks.PUBLIC })
      .addOperation(b.cctpStellarBurnOperations(intent(27, { sender: account }), 123456).burn).setTimeout(60).build() : TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
    tx.sign(key); return { signedTxXdr: tx.toXDR(), signerAddress: account };
  } };
const server = { getNetwork: async () => ({ passphrase: Networks.PUBLIC }), sendTransaction: async () => { broadcasts++; events.push('send'); return { hash, status: 'PENDING' }; } };
const submit = load('cctp-stellar-wallet').submitCctpStellarTransaction;
assert.equal(await submit(encoded, account, { beforeSign: () => events.push('before'), submitted: h => events.push(h) }, { wallet, server }), hash);
assert.deepEqual(events, ['before', 'sign', 'before', hash, 'send']);
network = Networks.TESTNET; await assert.rejects(() => submit(encoded, account, {}, { wallet, server }), /mainnet/);
network = Networks.PUBLIC; mutate = true;
await assert.rejects(() => submit(encoded, account, {}, { wallet, server }), /changed/i);
assert.equal(broadcasts, 1);
mutate = false;
await assert.rejects(() => submit(encoded, account, { submitted() { throw Error('storage full'); } }, { wallet, server }), /storage/);
assert.equal(broadcasts, 1, 'no broadcast if the signed hash cannot be saved');
console.log('CCTP Stellar wallet: Freighter network/account binding, signed-message integrity and hash persistence before broadcast passed.');

const { xdr, nativeToScVal } = await import('@stellar/stellar-sdk');
const { createCctpStellarMonitor } = load('cctp-stellar-monitor');
const proof = nativeProof(27, stellar);
let receiptStatus = 'SUCCESS', rpcNetwork = Networks.PUBLIC, emitter = n.CCTP_STELLAR.transmitter, receiptHash = hash;
const event = () => xdr.ContractEvent.fromXdrObject({ ext: { v: 0 }, contractId: StrKey.decodeContract(emitter), type: 1,
  body: { v: 0, v0: { topics: [nativeToScVal('message_sent', { type: 'symbol' }).toXdrObject()], data: nativeToScVal({ message: Buffer.from(proof.message.slice(2), 'hex') }).toXdrObject() } } });
const monitor = createCctpStellarMonitor({
  getNetwork: async () => ({ passphrase: rpcNetwork }),
  getTransaction: async () => ({ txHash: receiptHash, status: receiptStatus, envelopeXdr: encoded, events: { contractEventsXdr: [[event()]] } }),
  simulateTransaction: async tx => {
    const call = tx.operations[0].func.invokeContract;
    const value = { get_local_domain: 27, get_version: 1, get_signature_threshold: 1, get_num_enabled_attesters: 1,
      get_enabled_attester: Buffer.alloc(20, 1), is_nonce_used: true }[call.functionName.toString()];
    return { transactionData: {}, result: { retval: typeof value === 'number' ? nativeToScVal(value, { type: 'u32' }) : nativeToScVal(value) } };
  },
});
assert.equal((await monitor.attesters()).threshold, 1);
assert.equal(await monitor.nonceUsed('0x' + '01'.repeat(32)), true);
assert.equal((await monitor.receipt(hash, true)).message, proof.message);
emitter = n.CCTP_STELLAR.forwarder; await assert.rejects(() => monitor.receipt(hash, true), /Circle/);
receiptStatus = 'NOT_FOUND'; assert.equal((await monitor.receipt(hash)).state, 'pending');
receiptStatus = 'FAILED'; assert.equal((await monitor.receipt(hash)).state, 'failed');
receiptHash = 'b'.repeat(64); await assert.rejects(() => monitor.receipt(hash), /hash/);
rpcNetwork = Networks.TESTNET; await assert.rejects(() => monitor.attesters(), /mainnet/);
console.log('CCTP Stellar monitor: network passphrase, simulated state reads, envelope hash, exact Circle event emitter and nonce checks passed.');
