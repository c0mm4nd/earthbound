import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
const commonJsModule = { exports: {} };
new Script(ts.transpileModule(readFileSync(new URL('../src/lib/solana-confirmation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText).runInNewContext({ module: commonJsModule, exports: commonJsModule.exports, setTimeout });
const { inspectSolanaSubmission, confirmSolanaSubmission, SolanaConfirmationError } = commonJsModule.exports;
const submission = { signature: 'submitted-signature', validity: { blockhash: 'old-blockhash', lastValidBlockHeight: 100 } };
function rpc(statuses, height = 101) {
  let reads = 0;
  return {
    calls: [],
    async getSignatureStatuses(signatures, options) {
      this.calls.push('status');
      assert.equal(signatures[0], submission.signature);
      assert.equal(options.searchTransactionHistory, true);
      const result = statuses[Math.min(reads++, statuses.length - 1)];
      if (result instanceof Error) throw result;
      return { value: [result] };
    },
    async getBlockHeight(commitment) { assert.equal(commitment, 'finalized'); this.calls.push('height'); return height; },
  };
}
const confirmed = { err: null, confirmationStatus: 'confirmed', confirmations: 2 };
const processed = { err: null, confirmationStatus: 'processed', confirmations: 0 };
// A landed Phantom signature wins even if the original transaction's blockhash has expired.
const landed = rpc([confirmed]);
await confirmSolanaSubmission(landed, submission, { timeoutMs: 0 });
assert.deepEqual(landed.calls, ['status']);
// Confirmation can become visible while checking expiration: historical status wins.
assert.equal((await inspectSolanaSubmission(rpc([null, confirmed]), submission)).outcome, 'confirmed');
assert.equal((await inspectSolanaSubmission(rpc([null, null]), submission)).outcome, 'expired');
assert.equal((await inspectSolanaSubmission(rpc([processed, processed]), submission)).outcome, 'pending');
assert.equal((await inspectSolanaSubmission(rpc([null], 99), submission)).outcome, 'pending');
assert.equal((await inspectSolanaSubmission(rpc([{ ...processed, err: { InstructionError: [0, 'Custom'] } }]), submission)).outcome, 'pending');
// An RPC failure is never evidence of expiry or execution failure.
assert.equal((await inspectSolanaSubmission(rpc([new Error('403')]), submission)).outcome, 'pending');
assert.equal((await inspectSolanaSubmission(rpc([null, new Error('429')]), submission)).outcome, 'pending');
const walletBroadcast = rpc([null]);
assert.equal((await inspectSolanaSubmission(walletBroadcast, { signature: submission.signature })).outcome, 'pending');
assert.deepEqual(walletBroadcast.calls, ['status'], 'Do not apply pre-wallet blockhash lifetime to wallet-broadcast signatures');
await assert.rejects(confirmSolanaSubmission(rpc([null], 99), submission, { timeoutMs: 0 }), (error) => error instanceof SolanaConfirmationError && error.outcome === 'pending' && error.transactionHash === submission.signature);
await assert.rejects(confirmSolanaSubmission(rpc([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]), submission, { timeoutMs: 0 }), (error) => error.outcome === 'failed' && error.message.includes('InstructionError'));
await confirmSolanaSubmission(rpc([null, processed, confirmed], 99), submission, { pollIntervalMs: 1, timeoutMs: 100 });
console.log('Solana confirmation: landed signatures, late historical confirmation, genuine expiry, RPC failures, pending timeout, wallet blockhash replacement, and on-chain failure passed.');
