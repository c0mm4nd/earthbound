import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
const cjs = { exports: {} };
new Script(ts.transpileModule(readFileSync(new URL('../src/lib/execution-history.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText).runInNewContext({ module: cjs, exports: cjs.exports });
const { EXECUTION_HISTORY_KEY: key, loadExecutionHistory, parseExecutionHistory, mergeExecutionHistory, recoverExecutionHistory } = cjs.exports;
function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}
const item = { id: 'transfer-1', quoteId: 'quote-1', phase: 'success', createdAt: 1, updatedAt: 2, routeLabel: 'Direct OFT', srcChainName: 'Solana', dstChainName: 'Ethereum', srcTokenSymbol: 'USDG', dstTokenSymbol: 'USDG', srcAmount: '1 USDG', expectedDstAmount: '1 USDG', destinationAddress: '0x1', txHash: 'signature', solanaSubmission: { signature: 'signature' } };
const durable = memoryStorage(), oldTab = memoryStorage();
oldTab.setItem(key, JSON.stringify([item]));
assert.equal(loadExecutionHistory(durable, oldTab)[0].txHash, 'signature');
assert.equal(oldTab.getItem(key), null, 'Remove legacy copy after successful migration');
assert.equal(loadExecutionHistory(durable, memoryStorage())[0].id, item.id, 'A new tab has empty sessionStorage but restores durable history');
assert.equal(loadExecutionHistory(durable, memoryStorage())[0].id, item.id, 'Repeated loads preserve saved history');
const stale = { ...item, phase: 'pending', updatedAt: 1 };
assert.equal(mergeExecutionHistory([item], [stale])[0].phase, 'success', 'An old tab cannot overwrite a newer confirmation');
assert.equal(mergeExecutionHistory([item], [{ ...item, id: 'transfer-2', createdAt: 3 }]).length, 2);
assert.equal(mergeExecutionHistory(Array.from({ length: 35 }, (_, i) => ({ ...item, id: String(i), createdAt: i }))).length, 30);
const interrupted = recoverExecutionHistory([{ ...item, phase: 'running' }])[0];
assert.equal(interrupted.phase, 'pending');
assert.equal(interrupted.solanaSubmission.signature, 'signature');
assert.equal(recoverExecutionHistory([item])[0].phase, 'success');
const migrationSource = memoryStorage();
migrationSource.setItem(key, JSON.stringify([item]));
assert.throws(() => loadExecutionHistory({ getItem: () => null, setItem: () => { throw Error('QuotaExceededError'); } }, migrationSource), /Quota/);
assert.ok(migrationSource.getItem(key), 'Failed durable write must retain legacy history');
assert.equal(loadExecutionHistory(durable, { getItem: () => { throw Error('Session access disabled'); } })[0].id, item.id);
for (const value of ['broken', '{}', '[null,1,{"id":"bad"}]']) assert.equal(parseExecutionHistory(value).length, 0);
console.log('Execution history: migration, new-tab restoration, repeated loads, latest-update merging, interrupted Solana recovery, size limit, corrupt data, and storage failures passed.');
