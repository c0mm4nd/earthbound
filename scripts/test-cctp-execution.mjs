import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, toHex } from 'viem';
import { load, evm, transfer, burnHash, claimHash, message, receipt, proof, iris, client } from './helpers/cctp-fixture.mjs';
const { initiateCctpTransfer, monitorCctpTransfer, claimCctpTransfer, verifyCctpProof } = load('cctp-lifecycle');
const { assertCctpMessage, selectCctpAttestation } = load('cctp-message');
const original = { ...transfer, sourceMessage: message(), burnHash };

test('burn approves exact USDC, persists intent/hash before waiting, and verifies the source event', async () => {
  const events = [], saved = [], calls = [];
  const result = await initiateCctpTransfer(transfer, {
    source: client(0), destination: client(6), assertContext() {}, refreshFee: async () => 10000n,
    send: async (tx, kind) => { calls.push(tx); events.push('send:' + kind); return burnHash; },
    wait: async (_, kind) => { events.push('wait:' + kind); if (kind === 'burn') assert.equal(saved.at(-1).burnHash, burnHash); return receipt(); },
    persist: t => { saved.push(t); events.push('save:' + t.state); }, step() {},
  });
  assert.equal(result.state, 'attestation_pending');
  assert.equal(result.sourceMessage, message());
  assert.ok(events.indexOf('save:burn_pending') < events.indexOf('send:burn'));
  const burn = decodeFunctionData({ abi: evm.CCTP_ABI, data: calls.at(-1).data });
  assert.equal(burn.functionName, 'depositForBurn');
  assert.equal(burn.args[0], 100000000n);
  assert.equal(burn.args[5], 10000n);
});

test('increased fee, changed network and failed durable write prevent a burn', async () => {
  for (const scenario of ['fee', 'network', 'storage', 'wallet']) {
    let burns = 0;
    await assert.rejects(() => initiateCctpTransfer(transfer, {
      source: client(0, scenario === 'network' ? { getChainId: async () => 8453 } : {}), destination: client(6),
      assertContext() { if (scenario === 'wallet') throw Error('wallet changed'); }, refreshFee: async () => scenario === 'fee' ? 10001n : 10000n,
      send: async (_, kind) => { if (kind === 'burn') burns++; return burnHash; }, wait: async () => receipt(), step() {},
      persist() { if (scenario === 'storage') throw Error('storage full'); },
    }));
    assert.equal(burns, 0);
  }
});

test('ambiguous burn errors remain recoverable; wallet rejection is explicitly failed', async () => {
  for (const code of [4001, -32000]) {
    let saved;
    await assert.rejects(() => initiateCctpTransfer(transfer, {
      source: client(0), destination: client(6), assertContext() {}, refreshFee: async () => 10000n,
      send: async (_, kind) => { if (kind === 'burn') throw Object.assign(Error('wallet result'), { code }); return burnHash; },
      wait: async () => receipt(), step() {}, persist: t => saved = t,
    }));
    assert.equal(saved.state, code === 4001 ? 'failed' : 'burn_pending');
  }
});

test('attestation binds raw immutable bytes, tokens, sender, recipient, domains and limits', async () => {
  const p = await proof();
  assertCctpMessage(p.message, original, true);
  for (const offset of [0, 4, 8, 44, 76, 108, 140, 148, 152, 184, 216, 248, 280]) {
    const pos = 2 + offset * 2;
    const changed = p.message.slice(0, pos) + (p.message.slice(pos, pos + 2) === 'ff' ? '00' : 'ff') + p.message.slice(pos + 2);
    assert.throws(() => assertCctpMessage(changed, original, true));
  }
  assert.throws(() => assertCctpMessage(p.message, { ...original, sourceMessage: undefined }, true), /receipt/);
  assert.throws(() => selectCctpAttestation(iris(p), { ...original, amount: '200000000' }), /does not match/);
  await verifyCctpProof(client(6), original, p);
  await assert.rejects(() => verifyCctpProof(client(6), original, { ...p, attestation: '0x' }), /signatures/);
  await assert.rejects(() => verifyCctpProof(client(6, { readContract: async () => 0n }), original, p), /verification/);
});

test('Circle complete means ready; only authenticated consumed nonce means delivered', async () => {
  const p = await proof();
  const monitor = destination => monitorCctpTransfer(original, { source: client(0), destination, messages: async () => iris(p) });
  const ready = await monitor(client(6));
  assert.equal(ready.transfer.state, 'ready');
  const dest = client(6), read = dest.readContract;
  dest.readContract = args => args.functionName === 'usedNonces' ? 1n : read(args);
  assert.equal((await monitor(dest)).transfer.state, 'complete');
  const pending = await monitorCctpTransfer(original, { source: client(0), destination: client(6), messages: async () => ({ messages: [] }) });
  assert.equal(pending.transfer.state, 'attestation_pending');
});

test('claim constructs receiveMessage locally, simulates and saves before submission', async () => {
  const p = await proof();
  const t = { ...original, state: 'ready' }, saved = [];
  await claimCctpTransfer(t, p, {
    destination: client(6), account: transfer.sender, assertContext() {}, persist: t => saved.push(t),
    send: async tx => {
      assert.equal(saved.at(-1).state, 'claim_pending');
      assert.equal(tx.to, evm.cctpEvm(6).transmitter);
      const decoded = decodeFunctionData({ abi: evm.CCTP_ABI, data: tx.data });
      assert.equal(decoded.functionName, 'receiveMessage');
      assert.equal(decoded.args[0], p.message);
      return claimHash;
    },
  });
  assert.equal(saved.at(-1).claimHash, claimHash);
  let sent = false;
  await assert.rejects(() => claimCctpTransfer(t, p, {
    destination: client(6, { call: async () => { throw Error('Expired proof'); } }), account: transfer.sender,
    assertContext() {}, persist() {}, send: async () => { sent = true; return claimHash; },
  }), /Expired/);
  assert.equal(sent, false);
});

test('pending, failed and ambiguous claims recover without marking completed or repeating burn', async () => {
  const p = await proof();
  const run = (t, dest) => monitorCctpTransfer(t, { source: client(0), destination: dest, messages: async () => iris(p) });
  const t = { ...original, claimHash, state: 'claim_pending' };
  const pending = client(6, { getTransactionReceipt: async () => { throw Object.assign(Error('not found'), { name: 'TransactionReceiptNotFoundError' }); } });
  assert.equal((await run(t, pending)).transfer.state, 'claim_pending');
  const failed = await run(t, client(6, { getTransactionReceipt: async () => ({ status: 'reverted', transactionHash: claimHash }) }));
  assert.equal(failed.transfer.state, 'ready');
  assert.equal(failed.transfer.claimHash, undefined);
  assert.equal((await run({ ...t, claimHash: undefined }, client(6))).transfer.state, 'claim_pending');
  // A temporarily absent Iris proof or RPC receipt must not erase an ambiguous
  // wallet submission and re-enable a second claim on the next poll.
  const ambiguous = { ...t, claimHash: undefined };
  const noProof = await monitorCctpTransfer(ambiguous, { source: client(0), destination: client(6), messages: async () => ({ messages: [] }) });
  assert.equal(noProof.transfer.state, 'claim_pending');
  assert.equal((await run(noProof.transfer, client(6))).transfer.state, 'claim_pending');
  const noReceipt = await monitorCctpTransfer(ambiguous, { source: client(0, { getTransactionReceipt: pending.getTransactionReceipt }), destination: client(6), messages: async () => iris(p) });
  assert.equal(noReceipt.transfer.state, 'claim_pending');
});

test('history validates, persists and restores CCTP states without raw protocol labels', () => {
  const { parseExecutionHistory, recoverExecutionHistory, mergeExecutionHistory } = load('execution-history');
  const item = { id: 'cctp', quoteId: 'q', phase: 'running', createdAt: 1, updatedAt: 1, routeLabel: 'Circle CCTP',
    srcChainName: 'Ethereum', dstChainName: 'Base', srcTokenSymbol: 'USDC', dstTokenSymbol: 'USDC', srcAmount: '100', expectedDstAmount: '99.99', destinationAddress: transfer.recipient, cctp: { ...original, state: 'attestation_pending' } };
  const saved = parseExecutionHistory(JSON.stringify([item]));
  assert.equal(saved.length, 1);
  assert.equal(recoverExecutionHistory(saved)[0].phase, 'pending');
  assert.equal(recoverExecutionHistory(saved)[0].cctp.burnHash, burnHash);
  assert.equal(parseExecutionHistory(JSON.stringify([{ ...item, cctp: { ...item.cctp, burnHash: toHex(1) } }])).length, 0);
  const newer = Array.from({ length: 40 }, (_, index) => ({ ...item, cctp: undefined, id: 'new-' + index, createdAt: index + 2 }));
  assert.ok(mergeExecutionHistory([item], newer).some(record => record.id === item.id), 'unclaimed burns must survive the recent-history limit');
  for (const domain of [5, 8, 9, 25, 27]) assert.throws(() => evm.cctpEvm(domain), /development/, 'non-EVM must not use EVM burn/claim calldata');
});
