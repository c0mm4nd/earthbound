import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, MintLayout, AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';

const require = createRequire(import.meta.url);
const accounts = new Map();
let requestedRentSize;
class Connection {
  async getAccountInfo(key) { return accounts.get(key.toBase58()) ?? null; }
  async getMultipleAccountsInfo(keys) { return Promise.all(keys.map((key) => this.getAccountInfo(key))); }
  async getMinimumBalanceForRentExemption(size) { requestedRentSize = size; return 2039280; }
  async getAddressLookupTable() { return { value: null }; }
}
function load(name) {
  const m = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports,
    require: (id) => id === '@solana/web3.js' ? { ...web3, Connection } : id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const { createSolanaOftAdapter, receiveOptionValue } = load('direct-oft-solana');
const { decodeConsoleOftStore, decodeConsoleRateLimit, consoleInboundCapacity, discoverConsoleOftStores } = load('direct-oft-solana-console');
const { CONSOLE_OFT_PROGRAM_ID } = load('solana-oft-programs');
const pk = (v) => new web3.PublicKey(new Uint8Array(32).fill(v));
const program = new web3.PublicKey(CONSOLE_OFT_PROGRAM_ID), mint = pk(2), initializer = pk(3), recipient = pk(4);
const pda = (...seeds) => web3.PublicKey.findProgramAddressSync(seeds.map((s) => typeof s === 'string' ? Buffer.from(s) : s), program);
const be = (v, n) => { const b = Buffer.alloc(n); b.writeUInt32BE(v, n - 4); return b; };
const num = (v, n) => { const b = Buffer.alloc(n); if (n === 8) b.writeBigUInt64LE(BigInt(v)); else b.writeUIntLE(Number(v), 0, n); return b; };
const disc = (s) => createHash('sha256').update('account:' + s).digest().subarray(0, 8);
const [store, bump] = pda('OFT', initializer.toBuffer());
const [peer, peerBump] = pda('Peer', store.toBuffer(), be(30110, 4));
const [escrow] = pda('Escrow', store.toBuffer());
const [defaultsKey] = pda('RateLimit', store.toBuffer(), be(0, 16));
const [routeKey] = pda('RateLimit', store.toBuffer(), be(30110, 16));
const info = (owner, data, executable = false) => ({ owner, data, executable, lamports: 1e9 });
const put = (key, data, owner = program) => accounts.set(key.toBase58(), info(owner, data));
function storeData({ type = 0, rate = 1, shared = 6, init = initializer, token = mint, hook = pk(0), global = 0, disabled = 0 } = {}) {
  return Buffer.concat([disc('OFTStore'), num(type, 1), num(rate, 8), num(shared, 1), token.toBuffer(), init.toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(), num(bump, 1), hook.toBuffer(), num(0, 4), pk(5).toBuffer(), pk(0).toBuffer(),
    num(0, 1), num(0, 2), pk(6).toBuffer(), num(global, 1), num(disabled, 1), Buffer.alloc(32)]);
}
function rateData({ override = 0, out = 1, inbound = 1, net = 0, exempt = 0, limit = 2e6, usage = 1.5e6, updated = 1000 } = {}) {
  return Buffer.concat([disc('RateLimit'), Buffer.from([override, out, inbound, net, exempt]),
    ...[limit, limit, 100, 100, 0, usage, updated].map((v) => num(v, 8))]);
}
function setClock(time) {
  const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(time), 32);
  put(web3.SYSVAR_CLOCK_PUBKEY, b, pk(7));
}
function mintData(authority = store) {
  const b = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply: 10n ** 12n, decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: pk(0) }, b);
  return b;
}
function tokenData(owner, { frozen = false, amount = 0n } = {}) {
  const b = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: pk(0), state: frozen ? 2 : 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: pk(0) }, b);
  return b;
}
put(store, storeData());
put(peer, Buffer.concat([disc('OAppPeer'), Buffer.from('0'.repeat(24) + 'ffb20098fd7b8e84762eea4609f299d101427f24', 'hex'), num(peerBump, 1)]));
accounts.set(program.toBase58(), info(pk(7), Buffer.alloc(0), true));
put(mint, mintData(), TOKEN_PROGRAM_ID);
put(escrow, tokenData(store), TOKEN_PROGRAM_ID);
put(defaultsKey, rateData()); put(routeKey, rateData({ override: 1 })); setClock(1000);
const args = { storeAddress: store.toBase58(), deployment: { address: mint.toBase58() }, token: { address: mint.toBase58(), decimals: 6 }, remoteEid: 30110, simulate: false };
// Exercise dispatch through the same factory as standard OFT, with no token-symbol routing.
const adapter = await createSolanaOftAdapter(args);
assert.equal(adapter.tokenAddress, mint.toBase58());
assert.equal(adapter.sharedDecimals, 6);
assert.equal(receiveOptionValue(await adapter.receiveOptions(recipient.toBase58(), '0x0003')), 2039280n);
assert.equal(requestedRentSize, 165);
await assert.rejects(adapter.validateReceive(recipient.toBase58(), 1000000n), /receive limit/);
setClock(1050);
await adapter.validateReceive(recipient.toBase58(), 1000000n);
const ata = getAssociatedTokenAddressSync(mint, recipient, true);
put(ata, tokenData(recipient), TOKEN_PROGRAM_ID);
assert.equal(await adapter.receiveOptions(recipient.toBase58(), '0x0003'), '0x');
put(ata, tokenData(recipient, { frozen: true }), TOKEN_PROGRAM_ID);
await assert.rejects(adapter.receiveOptions(recipient.toBase58(), '0x0003'), /frozen/);
const signer = web3.Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const source = await createSolanaOftAdapter({ ...args, from: signer.toBase58() });
assert.equal(source.enforcedOptions, '0x');
await assert.rejects(source.buildSteps(), /Source Solana token account does not exist/);
await assert.rejects(adapter.buildSteps(), /source wallet is required/);
assert.deepEqual(Array.from(await discoverConsoleOftStores('https://example.invalid', mint.toBase58())), [store.toBase58()]);
const { encodeConsoleOftInstruction, decodeConsoleOftQuote } = load('direct-oft-solana-console-send');
const param = { dstEid: 30110, to: '0x' + 'ab'.repeat(32), amountLD: 1234567n, minAmountLD: 1200000n, extraOptions: '0x0003', composeMsg: '0x', oftCmd: '0x' };
const sourceAta = getAssociatedTokenAddressSync(mint, signer);
put(sourceAta, tokenData(signer, { frozen: true, amount: param.amountLD }), TOKEN_PROGRAM_ID);
await assert.rejects(source.buildSteps(param), /is frozen\. Contact the token issuer/);
put(sourceAta, tokenData(signer), TOKEN_PROGRAM_ID);
await assert.rejects(source.buildSteps(param), /Insufficient token balance/);
put(sourceAta, tokenData(recipient, { amount: param.amountLD }), TOKEN_PROGRAM_ID);
await assert.rejects(source.buildSteps(param), /does not match the wallet/);
const encoded = encodeConsoleOftInstruction('send', param, { nativeFee: 123n, lzTokenFee: 0n });
assert.equal(encoded.subarray(0,8).toString('hex'), createHash('sha256').update('global:send').digest('hex').slice(0,16));
assert.equal(encoded.readUInt32LE(8), 30110);
assert.equal(encoded.subarray(12,44).toString('hex'), 'ab'.repeat(32));
assert.equal(encoded.readBigUInt64LE(44), param.amountLD);
assert.equal(encoded.readBigUInt64LE(52), param.minAmountLD);
assert.equal(encoded.readUInt32LE(60), 2);
assert.equal(encoded[66], 0); // compose None, followed by nativeFee / lzTokenFee
assert.equal(encoded.readBigUInt64LE(67), 123n);
assert.equal(encoded.length, 83);
assert.equal(encodeConsoleOftInstruction('quote_oft', param).length, 68); // includes deprecated payInLzToken
assert.throws(() => encodeConsoleOftInstruction('send', { ...param, composeMsg: '0xab' }), /single-hop/);
assert.throws(() => encodeConsoleOftInstruction('send', { ...param, amountLD: 1n << 64n }), /amount/);
assert.throws(() => encodeConsoleOftInstruction('send', param, { nativeFee: 1n, lzTokenFee: 1n }), /native fee/);
const quoteBytes = Buffer.concat([num(0,8), num(9000000,8), num(1,4), Buffer.alloc(16), num(3,4), Buffer.from('Fee'), num(1234567,8), num(1200000,8)]);
const receipt = decodeConsoleOftQuote(quoteBytes);
assert.equal(receipt.amountReceivedLD, 1200000n);
assert.equal(receipt.maxAmountLD, 9000000n);
assert.throws(() => decodeConsoleOftQuote(quoteBytes.subarray(0, -1)), /layout/);
assert.throws(() => decodeConsoleOftQuote(Buffer.alloc(5)), /Truncated/);
await assert.rejects(createSolanaOftAdapter({ ...args, deployment: { details: { oftProgramId: pk(1).toBase58() } } }), /program does not match/);
await assert.rejects(createSolanaOftAdapter({ ...args, token: { ...args.token, address: pk(8).toBase58() } }), /mint does not match/);
put(store, storeData({ init: pk(9) }));
await assert.rejects(createSolanaOftAdapter(args), /store PDA/);
put(store, storeData({ rate: 10 }));
await assert.rejects(createSolanaOftAdapter(args), /decimal configuration/);
put(store, storeData({ hook: pk(9) }));
await assert.rejects(createSolanaOftAdapter(args), /hook configuration/);
put(store, storeData()); put(mint, mintData(pk(9)), TOKEN_PROGRAM_ID);
await assert.rejects(createSolanaOftAdapter(args)); // unknown mint authority, no permissive fallback
put(mint, mintData(), TOKEN_PROGRAM_ID);
put(store, storeData({ type: 1 }));
await assert.rejects((await createSolanaOftAdapter(args)).validateReceive(recipient.toBase58(), 1n), /insufficient liquidity/);
// Buffer slices can have nonzero byteOffset; Borsh reads must honor it.
const padded = Buffer.concat([Buffer.alloc(13), storeData()]).subarray(13);
assert.equal(decodeConsoleOftStore(padded).rate, 1n);
assert.throws(() => decodeConsoleOftStore(padded.subarray(0, 20)), /Truncated/);
assert.throws(() => decodeConsoleOftStore(Buffer.concat([padded, Buffer.from([1])])), /layout/);
assert.throws(() => decodeConsoleOftStore(storeData({ type: 2 })), /type/);
const defaults = decodeConsoleRateLimit(rateData()), route = decodeConsoleRateLimit(rateData({ override: 1, limit: 4e6 }));
const perRoute = { useGlobalState: false, globallyDisabled: false };
assert.equal(consoleInboundCapacity(perRoute, defaults, route, false, 1000n), 2500000n);
assert.equal(consoleInboundCapacity({ ...perRoute, useGlobalState: true }, defaults, route, false, 1000n), 500000n);
assert.equal(consoleInboundCapacity(perRoute, defaults, { ...route, override: false }, false, 1000n), 500000n);
assert.throws(() => consoleInboundCapacity(perRoute, defaults, null, false, 1000n), /not initialized/);
assert.throws(() => consoleInboundCapacity(perRoute, defaults, route, false, 999n), /chain clock/);
const max = (1n << 64n) - 1n;
assert.equal(consoleInboundCapacity({ ...perRoute, globallyDisabled: true }, defaults, null, false, 1000n), max);
assert.equal(consoleInboundCapacity(perRoute, { ...defaults, exempt: true }, null, true, 1000n), max);
assert.throws(() => consoleInboundCapacity(perRoute, defaults, null, true, 1000n), /not initialized/);
assert.equal(consoleInboundCapacity(perRoute, { ...defaults, inbound: false, net: false }, null, false, 1000n), max);
assert.throws(() => consoleInboundCapacity(perRoute, { ...defaults, inbound: false, net: true }, null, false, 1000n), /not initialized/);
console.log('Console OFT: automatic program dispatch, layout/PDA/peer/mint checks, receive rent, frozen ATA, mint authority, liquidity, rate-limit decay/overrides/exemptions, source dispatch, mint-authority discovery, send serialization, quote decoding and source wallet guards passed.');
