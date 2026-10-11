import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-ts.mjs';
const { EXECUTION_HISTORY_KEY: key, loadExecutionHistory, parseExecutionHistory, mergeExecutionHistory, recoverExecutionHistory } = createLoader()('execution-history');
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

const ccipItem = { ...item, solanaSubmission: undefined, phase: 'running', ccipSubmission: { chainId: 1, hash: '0x' + '1'.repeat(64), confirmed: false } };
assert.equal(recoverExecutionHistory([ccipItem])[0].phase, 'pending');
assert.equal(recoverExecutionHistory([ccipItem])[0].transferStatus, 'CONFIRMATION_PENDING');
assert.equal(recoverExecutionHistory([{ ...ccipItem, ccipSubmission: { ...ccipItem.ccipSubmission, confirmed: true } }])[0].transferStatus, 'PENDING');
assert.equal(parseExecutionHistory(JSON.stringify([ccipItem])).length, 1);
assert.equal(parseExecutionHistory(JSON.stringify([{ ...ccipItem, ccipSubmission: { hash: 'invalid' } }])).length, 0);
console.log('CCIP interrupted send and settlement recovery passed.');
for (const [family, hash] of [['SOLANA', '2'.repeat(88)], ['APTOS', '0x' + '2'.repeat(64)], ['CANTON', '1220' + 'a'.repeat(64)]]) {
  const record = { ...ccipItem, ccipSubmission: { chainId: 1, family, hash, confirmed: false } };
  assert.equal(parseExecutionHistory(JSON.stringify([record])).length, 1);
  assert.equal(recoverExecutionHistory([record])[0].phase, 'pending');
}
assert.equal(parseExecutionHistory(JSON.stringify([{ ...ccipItem, ccipSubmission: { chainId: 1, family: 'SOLANA', hash: '0x' + 'a'.repeat(64), confirmed: false } }])).length, 0, 'EVM hash cannot be recovered as a Solana signature');
console.log('Independent source-family hash recovery passed.');

const nativeConversion = { chainId: 177, chainKey: 'hsk', token: '0x' + 'a'.repeat(40), amount: '1000000000000000000', account: '0x' + 'b'.repeat(40), hash: '0x' + 'c'.repeat(64), confirmed: false };
const wrappingItem = { ...item, solanaSubmission: undefined, phase: 'running', ccipWrap: nativeConversion };
assert.equal(parseExecutionHistory(JSON.stringify([wrappingItem])).length, 1);
assert.equal(recoverExecutionHistory([wrappingItem])[0].phase, 'pending');
assert.equal(recoverExecutionHistory([wrappingItem])[0].ccipWrap.hash, nativeConversion.hash);
assert.equal(recoverExecutionHistory([wrappingItem])[0].transferStatus, 'CONFIRMATION_PENDING');
const unwrappingItem = { ...ccipItem, phase: 'success', transferStatus: 'COMPLETED', ccipUnwrap: { ...nativeConversion, hash: undefined } };
assert.equal(parseExecutionHistory(JSON.stringify([unwrappingItem])).length, 1, 'settled CCIP can retain a separate destination unwrap');
for (const invalid of [{ amount: '0' }, { amount: (2n ** 256n).toString() }, { hash: 'broken' }, { chainId: 1.1 }, { account: 'invalid' }, { token: 'invalid' }, { confirmed: 'yes' }]) {
  assert.equal(parseExecutionHistory(JSON.stringify([{ ...wrappingItem, ccipWrap: { ...nativeConversion, ...invalid } }])).length, 0);
}
console.log('Native conversion history: pending wrap recovery, destination unwrap retention and malformed data rejection passed.');
