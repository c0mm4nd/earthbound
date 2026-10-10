// Opt-in mainnet reads and unsigned simulations only. No signatures or broadcasts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createPublicClient, http } from 'viem';
import * as chains from 'viem/chains';
if (process.env.LIVE_OFT_PEERS !== '1') {
  console.log('Skipped live peer checks. Set LIVE_OFT_PEERS=1 (read-only / unsigned simulation).');
  process.exit(0);
}
const require = createRequire(import.meta.url), modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const m = { exports: {} }; modules.set(name, m);
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, fetch, AbortSignal, Buffer, Uint8Array, setTimeout, atob, btoa,
    require: id => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/oft-peer-live.json', import.meta.url), 'utf8'));
const chain = key => fixture.chains.find(c => c.chainKey === key);
const token = (key, symbol) => fixture.tokens.find(t => t.chainKey === key && t.symbol === symbol);
const evmWallet = '0x1111111111111111111111111111111111111111';
const solWallet = '5Gxia7g5uNu3zR6uaT3xx83wBVVsnBwLBVgMrLstCoWP';
const clients = new Map();
const selected = symbol => !process.env.LIVE_OFT_SYMBOLS || process.env.LIVE_OFT_SYMBOLS.split(',').includes(symbol);
function client(key) {
  if (!clients.has(key)) clients.set(key, createPublicClient({ transport: http(key === 'ethereum' ? 'https://ethereum-rpc.publicnode.com'
    : Object.values(chains).find(c => c.id === chain(key).chainId).rpcUrls.default.http[0], { timeout: 20000, retryCount: 1 }) }));
  return clients.get(key);
}
async function quote(src, dst, from, to) {
  return load('direct-oft').buildDirectOftQuote({ metadata: {}, discoverPeers: true, simulate: true,
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com',
    srcChain: chain(src.chainKey), dstChain: chain(dst.chainKey), srcToken: src, dstToken: dst,
    amount: 10n ** BigInt(src.decimals), from, to,
    read: ({ chain, ...req }) => client(chain.chainKey).readContract(req),
    readNativeBalance: (chain, address) => client(chain.chainKey).getBalance({ address }),
    readEvmCode: (chain, address) => client(chain.chainKey).getCode({ address }),
    fetchDiscoveryQuote: async () => { throw new Error('Unexpected API discovery'); },
  });
}
for (const symbol of ['USDe', 'ENA', 'sUSDe'].filter(selected)) {
  const sol = token('solana', symbol), eth = token('ethereum', symbol);
  const holder = fixture.holders.find(h => h.symbol === symbol).owner;
  for (const [src, dst, from, to] of [[sol, eth, holder, evmWallet], [eth, sol, evmWallet, holder]]) {
    const q = await quote(src, dst, from, to);
    assert.equal(q.dstAmount, String(10n ** BigInt(dst.decimals)));
    assert.ok(q.directOft);
    assert.equal(q.fees.length, 1);
    console.log(`${symbol} ${src.chainKey} → ${dst.chainKey}: quote passed${src.chainKey === 'solana' ? ', unsigned send simulation passed' : ''}`);
  }
}
for (const [symbol, key] of [['S', 'sonic'], ['APE', 'ape'], ['CHZ', 'chiliz'], ['SEI', 'sei'], ['XDC', 'xdc'], ['INJ', 'injectiveevm'], ['RBNT', 'redbelly']].filter(([symbol]) => selected(symbol))) {
  const src = token(key, symbol), dst = token('solana', symbol), q = await quote(src, dst, evmWallet, solWallet);
  const tx = q.userSteps.at(-1).transaction.encoded;
  assert.equal(q.dstAmount, String(10n ** BigInt(dst.decimals)));
  assert.equal(q.userSteps.length, 1);
  assert.equal(BigInt(tx.value), BigInt(q.directOft.nativeFee) + 10n ** BigInt(src.decimals));
  await client(key).call({ account: evmWallet, to: tx.to, data: tx.data, value: BigInt(tx.value),
    stateOverride: [{ address: evmWallet, balance: 10n ** 30n }] });
  const holder = fixture.holders.find(h => h.symbol === symbol).owner;
  const reverse = await quote(dst, src, holder, evmWallet);
  assert.equal(reverse.dstAmount, String(10n ** BigInt(src.decimals)));
  console.log(`${symbol} ${key} ↔ solana: both quotes and both unsigned source sends passed (EVM dummy sender balance override)`);
}

if (selected('PEAQ')) {
  const sol = token('solana', 'PEAQ'), native = token('peaq', 'PEAQ');
  const holder = fixture.holders.find(h => h.symbol === 'PEAQ').owner;
  const outbound = await quote(native, sol, evmWallet, holder);
  assert.equal(outbound.dstAmount, String(10n ** BigInt(sol.decimals)));
  assert.equal(outbound.userSteps.length, 2, 'Approve precompile then send');
  assert.equal(outbound.userSteps[0].transaction.encoded.to.toLowerCase(), '0x0000000000000000000000000000000000000809');
  assert.equal(outbound.userSteps.at(-1).transaction.encoded.value, outbound.directOft.nativeFee);
  const inbound = await quote(sol, native, holder, evmWallet);
  assert.equal(inbound.dstAmount, '1000000000000000000');
  const approved = await quote(native, sol, fixture.peaqEvmHolder, holder);
  assert.equal(approved.userSteps.length, 1, 'Public holder already has sufficient allowance');
  const tx = approved.userSteps[0].transaction.encoded;
  await client('peaq').call({ account: fixture.peaqEvmHolder, to: tx.to, data: tx.data, value: BigInt(tx.value) });
  console.log('PEAQ ↔ solana: both quotes and both unsigned source sends passed; no peaq state overrides');
}
