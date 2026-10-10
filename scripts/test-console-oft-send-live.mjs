// Opt-in mainnet reads and unsigned simulation only. Never signs or broadcasts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createPublicClient, http } from 'viem';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
if (process.env.LIVE_CONSOLE_OFT !== '1') {
  console.log('Set LIVE_CONSOLE_OFT=1 to verify USDai and sUSDai Solana → Arbitrum with unsigned mainnet simulations.');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const m = { exports: {} }; cache.set(name, m.exports);
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, btoa, atob,
    require: (id) => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return m.exports;
}
const { buildDirectOftQuote } = load('direct-oft');
const { CONSOLE_OFT_PROGRAM_ID } = load('solana-oft-programs');
const client = createPublicClient({ transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 1 }) });
const srcChain = { chainKey: 'solana', chainType: 'SOLANA', nativeCurrency: { symbol: 'SOL', decimals: 9 } };
const dstChain = { chainKey: 'arbitrum', chainId: 42161, chainType: 'EVM', nativeCurrency: { symbol: 'ETH', decimals: 18 } };
for (const [symbol, mint, evmToken, publicHolder] of [
  ['USDai', 'USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A', '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF', '5Gxia7g5uNu3zR6uaT3xx83wBVVsnBwLBVgMrLstCoWP'],
  ['sUSDai', 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE', '0x0B2b2B2076d95dda7817e785989fE353fe955ef9', 'GzSdeEUic3Lm3LAZgutceEYMZLbJr2ggJVqRuBwr6YPC'],
]) {
  // Public holders are fee payers ONLY for sigVerify:false simulations. Their
  // balances can change; no private keys or wallet providers are ever used.
  let apiCalls = 0;
  const quote = await buildDirectOftQuote({ metadata: {}, discoverPeers: true, simulate: true,
    srcChain, dstChain, srcToken: { symbol, address: mint, decimals: 6 }, dstToken: { symbol, address: evmToken, decimals: 18 },
    from: publicHolder, to: '0x0000000000000000000000000000000000000001', amount: 1000000n,
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com',
    read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }),
    fetchDiscoveryQuote: async () => { apiCalls++; throw new Error('Console source discovery must not require API routes.'); },
  });
  assert.equal(apiCalls, 0);
  assert.equal(quote.userSteps.length, 1);
  assert.equal(quote.dstAmount, '1000000000000000000');
  const encoded = quote.userSteps[0].transaction.encoded;
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded.serializedTransaction, 'base64'));
  assert.ok(tx.signatures.every((s) => s.every((b) => b === 0)), 'No signatures may be produced');
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), publicHolder);
  assert.ok(tx.message.staticAccountKeys.some((key) => key.equals(new PublicKey(CONSOLE_OFT_PROGRAM_ID))));
  assert.equal(tx.message.recentBlockhash, encoded.blockhash);
  assert.ok(encoded.lastValidBlockHeight > 0);
  assert.ok(tx.serialize().length <= 1232);
  console.log(JSON.stringify({ route: `${symbol} Solana → Arbitrum`, dstAmount: quote.dstAmount,
    nativeFee: quote.directOft.nativeFee, bytes: tx.serialize().length, simulation: 'passed', signed: false, broadcast: false, apiCalls }));
}
