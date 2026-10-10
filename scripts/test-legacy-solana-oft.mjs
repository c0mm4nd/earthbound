import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, MintLayout, AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { EndpointProgram } from '@layerzerolabs/lz-solana-sdk-v2';
const require = createRequire(import.meta.url), accounts = new Map(), modules = new Map();
class Connection {
  async getAccountInfo(key) { return accounts.get(key.toBase58()) ?? null; }
  async getMultipleAccountsInfo(keys) { return Promise.all(keys.map(k => this.getAccountInfo(k))); }
  async getMinimumBalanceForRentExemption(size) { assert.equal(size, 165); return 2039280; }
}
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const m = { exports: {} }; modules.set(name, m);
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer,
    require: id => id === '@solana/web3.js' ? { ...web3, Connection } : id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const { createSolanaOftAdapter, receiveOptionValue } = load('direct-oft-solana');
const { decodeLegacyOftStore, decodeLegacyOftPeer, legacyOftCapacity } = load('direct-oft-solana-legacy');
const { discoverSolanaOftStores } = load('direct-oft-solana-discovery');
const { encodeConsoleOftInstruction, decodeConsoleOftQuote } = load('direct-oft-solana-console-send');
const key = n => new web3.PublicKey(Buffer.alloc(32, n)), program = key(1), mint = key(2), owner = key(3), escrow = key(4);
const disc = name => createHash('sha256').update('account:' + name).digest().subarray(0, 8);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const eid = Buffer.alloc(4); eid.writeUInt32BE(30101);
const pda = (...seeds) => web3.PublicKey.findProgramAddressSync(seeds, program);
const [store, bump] = pda(Buffer.from('Oft'), mint.toBuffer());
const [peer, peerBump] = pda(Buffer.from('Peer'), store.toBuffer(), eid);
const put = (key, data, accountOwner = program, executable = false) => accounts.set(key.toBase58(), { data, owner: accountOwner, executable, lamports: 1e9 });
const data = Buffer.concat([disc('OftConfig'), u64(1000), mint.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), EndpointProgram.PROGRAM_ID.toBuffer(),
  Buffer.from([bump]), owner.toBuffer(), Buffer.from([0, 0]), Buffer.alloc(32, 7)]);
put(store, data);
put(program, Buffer.alloc(0), key(9), true);
const peerData = Buffer.concat([disc('Peer'), Buffer.alloc(32, 8), Buffer.from([0, peerBump]), Buffer.alloc(32, 9)]);
put(peer, peerData);
function mintData(authority = store) {
  const b = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply: 1000000n, decimals: 9, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: key(0) }, b); return b;
}
put(mint, mintData(), TOKEN_PROGRAM_ID);
const args = { storeAddress: store.toBase58(), token: { address: mint.toBase58(), decimals: 9 }, deployment: { address: mint.toBase58() }, remoteEid: 30101, simulate: false };
const a = await createSolanaOftAdapter(args);
assert.equal(a.sharedDecimals, 6);
assert.equal(decodeLegacyOftStore(data).authority, null, 'Cleared Option has stale allocated bytes');
assert.equal(decodeLegacyOftPeer(peerData).limit, null);
assert.equal(receiveOptionValue(await a.receiveOptions(owner.toBase58(), '0x0003')), 2039280n);
await a.validateReceive(owner.toBase58(), 1000n);
await assert.rejects(a.validateReceive(owner.toBase58(), 1n << 64n), /integer limits/);
await assert.rejects(a.buildSteps({}, {}), /wallet is required/);
assert.deepEqual(Array.from(await discoverSolanaOftStores('https://example.invalid', mint.toBase58(), {})), [store.toBase58()]);
const ata = getAssociatedTokenAddressSync(mint, owner, true);
const tokenData = (accountOwner, amount, state = 1) => {
  const b = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: accountOwner, amount, state, delegateOption: 0, delegate: key(0),
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: key(0) }, b); return b;
};
put(ata, tokenData(owner, 0n), TOKEN_PROGRAM_ID);
assert.equal(await a.receiveOptions(owner.toBase58(), '0x0003'), '0x');
put(ata, tokenData(owner, 0n, 2), TOKEN_PROGRAM_ID);
await assert.rejects(a.receiveOptions(owner.toBase58(), '0x0003'), /frozen/);
put(mint, mintData(key(8)), TOKEN_PROGRAM_ID);
await assert.rejects(createSolanaOftAdapter(args), /mint authority/);
put(mint, mintData(), TOKEN_PROGRAM_ID);
await assert.rejects(createSolanaOftAdapter({ ...args, token: { ...args.token, decimals: 6 } }), /decimals/);
const wrongCase = pda(Buffer.from('OFT'), mint.toBuffer())[0]; put(wrongCase, data);
await assert.rejects(createSolanaOftAdapter({ ...args, storeAddress: wrongCase.toBase58() }), /PDA/);
put(peer, peerData, key(7)); await assert.rejects(createSolanaOftAdapter(args), /missing or invalid/); put(peer, peerData);
const zeroPeer = Buffer.from(peerData); zeroPeer.fill(0, 8, 40); put(peer, zeroPeer);
await assert.rejects(createSolanaOftAdapter(args), /Invalid legacy OFT peer/); put(peer, peerData);
assert.throws(() => decodeLegacyOftStore(data.subarray(0, 178)), /allocation/);
assert.throws(() => decodeLegacyOftPeer(peerData.subarray(0, 40)), /Truncated/);
const limit = { capacity: 1000n, tokens: 100n, refill: 10n, updated: 1000n };
assert.equal(legacyOftCapacity(limit, 999n), 100n);
assert.equal(legacyOftCapacity(limit, 1050n), 600n);
assert.equal(legacyOftCapacity(limit, 2000n), 1000n);
const params = { dstEid: 30101, to: '0x' + '08'.repeat(32), amountLD: 1000n, minAmountLD: 1000n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' };
assert.equal(encodeConsoleOftInstruction('quote', params).subarray(0,8).toString('hex'), createHash('sha256').update('global:quote').digest('hex').slice(0,16));
const receipt = Buffer.concat([u64(0), u64(10000), Buffer.alloc(4), u64(1000), u64(1000)]);
assert.equal(decodeConsoleOftQuote(receipt, 8).amountReceivedLD, 1000n);
// Adapter custody uses the escrow in its seed and must check destination liquidity.
const [adapterStore, adapterBump] = pda(Buffer.from('Oft'), escrow.toBuffer());
const adapterData = Buffer.concat([data.subarray(0, 112), Buffer.from([adapterBump]), owner.toBuffer(), Buffer.from([1]), escrow.toBuffer(), Buffer.alloc(1)]);
assert.equal(adapterData.length, 179);
put(adapterStore, adapterData);
const [adapterPeer, adapterPeerBump] = pda(Buffer.from('Peer'), adapterStore.toBuffer(), eid);
put(adapterPeer, Buffer.concat([disc('Peer'), Buffer.alloc(32, 8), Buffer.from([0, adapterPeerBump]), Buffer.alloc(32)]));
put(escrow, tokenData(adapterStore, 999n), TOKEN_PROGRAM_ID);
const adapter = await createSolanaOftAdapter({ ...args, storeAddress: adapterStore.toBase58() });
await assert.rejects(adapter.validateReceive(owner.toBase58(), 1000n), /insufficient liquidity/);
await adapter.validateReceive(owner.toBase58(), 999n);
const metadata = { TOKEN: [{ endpointVersion: 'v2', deployments: { solana: { address: mint.toBase58(), details: { oftProgramId: program.toBase58(), escrowTokenAccount: escrow.toBase58() } } } }] };
assert.ok((await discoverSolanaOftStores('https://example.invalid', mint.toBase58(), metadata)).includes(adapterStore.toBase58()));
console.log('Legacy Solana OFT: dispatch, discovery, PDA, mint/peer validation, stale Option padding, ATA rent/freeze, rate refill, quote discriminator and escrow liquidity passed.');
