import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, pad, toHex, stringToHex } from 'viem';
import { attester } from './helpers/cctp-fixture.mjs';
import { load, intent, wallet, stellar, evm } from './helpers/cctp-native-fixture.mjs';
const binding = load('cctp-native-proof'), native = load('cctp-native'), lifecycle = load('cctp-native-lifecycle');
const hashFor = d => d === 5 ? '2'.repeat(88) : d === 8 ? wallet : d === 27 ? 'a'.repeat(64) : '0x' + '01'.repeat(32);
const address = d => d === 5 ? wallet : d === 27 ? stellar : d === 0 ? evm : '0x123';
async function fixture(source, destination) {
  const t = { ...intent(source, { destinationDomain: destination, sender: address(source), recipient: address(destination), amount: '1000000', maxFee: '100' }), state: 'attestation_pending', burnHash: hashFor(source) };
  const target = native.cctpMintTarget(destination, t.recipient), raw = Buffer.alloc(376 + (target.hook.length - 2) / 2);
  raw.writeUInt32BE(1, 0); raw.writeUInt32BE(source, 4); raw.writeUInt32BE(destination, 8); raw.writeUInt32BE(2000, 140); raw.writeUInt32BE(1, 148);
  for (const [offset, hex] of [[44, binding.cctpWireMessenger(source)], [76, binding.cctpWireMessenger(destination)], [108, target.destinationCaller],
    [152, binding.cctpWireUsdc(source)], [184, target.mintRecipient], [216, pad(toHex(1000000))], [248, binding.cctpWireAddress(source, t.sender)], [280, pad(toHex(100))], [376, target.hook]]) Buffer.from(hex.slice(2), 'hex').copy(raw, offset);
  const sourceMessage = toHex(raw); raw[43] = 1; raw.writeUInt32BE(2000, 144);
  const message = toHex(raw), proof = { message, attestation: await attester.sign({ hash: keccak256(message) }) };
  const deps = { sourceReceipt: async () => ({ state: 'confirmed', message: sourceMessage }), circleProof: async () => proof,
    destinationAttesters: async () => ({ domain: destination, threshold: 1, enabledAttesters: [attester.address] }), nonceUsed: async () => false, claimReceipt: async () => 'pending' };
  return { t, sourceMessage, proof, deps };
}

test('all 30 directed family pairs bind USDC identity, Stellar hooks and destination attesters', async () => {
  assert.equal(binding.cctpWireMessenger(8), keccak256(stringToHex('eb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830::message_transmitter_authenticator::MessageTransmitterAuthenticator')));
  assert.equal(binding.cctpWireMessenger(9), pad('0x52f4732b1cb52ce28f595e29978450132772f88277182e12bc431faa677be603'));
  for (const source of [0, 5, 8, 9, 25, 27]) for (const destination of [0, 5, 8, 9, 25, 27].filter(d => d !== source)) {
    const f = await fixture(source, destination);
    assert.equal((await lifecycle.monitorNativeCctp(f.t, f.deps)).transfer.state, 'ready');
    assert.equal((await lifecycle.monitorNativeCctp(f.t, { ...f.deps, nonceUsed: async () => true })).transfer.state, 'complete');
    for (const offset of [4, 8, 44, 76, 108, 140, 148, 152, 184, 216, 248, 280, ...(destination === 27 ? [376] : [])]) {
      const raw = Buffer.from(f.proof.message.slice(2), 'hex'); raw[offset] ^= 1;
      await assert.rejects(() => binding.verifyCctpNativeProof(f.t, f.sourceMessage, { ...f.proof, message: toHex(raw) }, awaitableSet(destination)));
    }
    await assert.rejects(() => binding.verifyCctpNativeProof(f.t, f.sourceMessage, f.proof, { domain: destination, threshold: 1, enabledAttesters: [evm] }), /attester/);
    await assert.rejects(() => binding.verifyCctpNativeProof(f.t, f.sourceMessage, f.proof, { domain: source, threshold: 1, enabledAttesters: [attester.address] }), /attester/);
  }
});
const awaitableSet = domain => ({ domain, threshold: 1, enabledAttesters: [attester.address] });

test('native submission persists intent/hash before waits and never retries an ambiguous wallet response', async () => {
  for (const domain of [5, 8, 9, 25, 27]) {
    const f = await fixture(domain, 0), start = { ...f.t, state: 'preparing', burnHash: undefined }, saved = [];
    const deps = { assertContext() {}, persist: t => saved.push(t), refreshFee: async () => 100n,
      prepareBurn: async () => async submitted => { assert.equal(saved.at(-1).state, 'burn_pending'); submitted(hashFor(domain)); assert.equal(saved.at(-1).burnHash, hashFor(domain)); throw Error('confirmation unavailable'); } };
    await assert.rejects(() => lifecycle.initiateNativeCctp(start, deps), /unavailable/);
    assert.equal(saved.at(-1).state, 'burn_pending');
    await assert.rejects(() => lifecycle.initiateNativeCctp(saved.at(-1), deps), /recovery/);
    let sends = 0;
    await assert.rejects(() => lifecycle.initiateNativeCctp(start, { ...deps, prepareBurn: async () => async () => { sends++; }, persist() { throw Error('storage full'); } }), /storage/);
    assert.equal(sends, 0);
    await assert.rejects(() => lifecycle.initiateNativeCctp(start, { ...deps, prepareBurn: async () => async () => { throw Object.assign(Error('rejected'), { code: 4001 }); } }), /rejected/);
    assert.equal(saved.at(-1).state, 'failed');
  }
});

test('native claims preserve ambiguous state across absent proof, recover reverts and check replay before signing', async () => {
  for (const domain of [5, 8, 9, 25, 27]) {
    const f = await fixture(0, domain), pending = { ...f.t, state: 'claim_pending' };
    const missing = await lifecycle.monitorNativeCctp(pending, { ...f.deps, circleProof: async () => null });
    assert.equal(missing.transfer.state, 'claim_pending');
    assert.equal((await lifecycle.monitorNativeCctp(missing.transfer, f.deps)).transfer.state, 'claim_pending');
    const reverted = await lifecycle.monitorNativeCctp({ ...pending, claimHash: hashFor(domain) }, { ...f.deps, claimReceipt: async () => 'failed' });
    assert.equal(reverted.transfer.state, 'ready'); assert.equal(reverted.transfer.claimHash, undefined);
    const saved = []; let sent = 0;
    const claimDeps = { ...f.deps, assertContext() {}, persist: t => saved.push(t), prepareClaim: async () => async submitted => {
      assert.equal(saved.at(-1).state, 'claim_pending'); sent++; submitted(hashFor(domain)); return hashFor(domain);
    } };
    await lifecycle.claimNativeCctp(f.t, claimDeps);
    assert.equal(sent, 1); assert.equal(saved.at(-1).claimHash, hashFor(domain));
    await lifecycle.claimNativeCctp(f.t, { ...claimDeps, nonceUsed: async () => true });
    assert.equal(sent, 1); assert.equal(saved.at(-1).state, 'complete');
    await assert.rejects(() => lifecycle.claimNativeCctp(f.t, { ...claimDeps, assertContext() { throw Error('wallet changed'); } }), /wallet changed/);
    assert.equal(sent, 1);
  }
});
