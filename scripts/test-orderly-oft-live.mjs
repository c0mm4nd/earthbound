// Read-only mainnet calls and unsigned simulations. Public holders are test
// fixtures, not connected wallets. No signing or broadcasting code is present.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createPublicClient, http, fallback, decodeFunctionData, padHex } from 'viem';
import * as viemChains from 'viem/chains';
import { Connection } from '@solana/web3.js';
import { EndpointProgram } from '@layerzerolabs/lz-solana-sdk-v2';
import bs58 from 'bs58';
if (process.env.LIVE_ORDERLY_OFT !== '1') {
  console.log('Skipped ORDER mainnet checks. Set LIVE_ORDERLY_OFT=1.'); process.exit(0);
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
const fixture = JSON.parse(readFileSync(new URL('./fixtures/orderly-live.json', import.meta.url), 'utf8'));
const token = key => fixture.tokens.find(t => t.chainKey === key), chain = key => fixture.chains.find(c => c.chainKey === key);
const clients = new Map();
function client(key) {
  if (!clients.has(key)) {
    const v = Object.values(viemChains).find(c => c.id === chain(key).chainId);
    const urls = [...(load('rpc-config').DEFAULT_RPC_URLS[key] || []), ...v.rpcUrls.default.http];
    clients.set(key, createPublicClient({ transport: fallback([...new Set(urls)].map(u => http(u, { timeout: 20000, retryCount: 0 }))) }));
  }
  return clients.get(key);
}
let packet;
const simulate = Connection.prototype.simulateTransaction;
Connection.prototype.simulateTransaction = async function (...args) {
  if (args[1]) args[1].innerInstructions = true;
  const result = await simulate.apply(this, args);
  if (result.value.err === null && result.value.logs?.includes('Program log: Instruction: Send')) {
    for (const ix of result.value.innerInstructions?.flatMap(i => i.instructions) || []) {
      if (!ix.data) continue;
      try {
        // Anchor event-CPI prefix + event discriminator precede event fields.
        const [event] = EndpointProgram.events.packetSentEventBeet.deserialize(Buffer.from(bs58.decode(ix.data)), 16);
        if (event.encodedPacket.length === 177) packet = Buffer.from(event.encodedPacket);
      } catch { /* Other CPI instructions are not PacketSent. */ }
    }
  }
  return result;
};
const evmWallet = '0x1111111111111111111111111111111111111111';
async function quote(srcKey, dstKey, from, to, dust = 0n) {
  const src = token(srcKey), dst = token(dstKey);
  return load('direct-oft').buildDirectOftQuote({ metadata: {}, discoverPeers: true, simulate: true,
    srcChain: chain(srcKey), dstChain: chain(dstKey), srcToken: src, dstToken: dst,
    amount: 100n * 10n ** BigInt(src.decimals) + dust, from, to,
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com',
    read: ({ chain, ...req }) => client(chain.chainKey).readContract(req),
    readEvmCode: (chain, address) => client(chain.chainKey).getCode({ address }),
    readEvmStorage: (chain, address, slot) => client(chain.chainKey).getStorageAt({ address, slot }),
    fetchDiscoveryQuote: async () => { throw new Error('ORDER must not need API hints'); },
  });
}
try {
  for (const key of fixture.chains.filter(c => c.chainType === 'EVM').map(c => c.chainKey)) {
    const forward = await quote(key, 'solana', evmWallet, fixture.solanaHolder, 123n);
    assert.equal(forward.dstAmount, '1000000000000');
    const tx = forward.userSteps.at(-1).transaction.encoded;
    const p = decodeFunctionData({ abi: load('custom-oft').layerZeroOftV2Abi, data: tx.data }).args[0];
    assert.equal(p.amountLD, 100n * 10n ** 18n, 'Dust remains in source wallet');
    packet = undefined;
    const reverse = await quote('solana', key, fixture.solanaHolder, evmWallet);
    assert.equal(reverse.dstAmount, '100000000000000000000');
    assert.ok(packet, 'Unsigned Solana send must emit a 177-byte packet');
    assert.equal(packet.subarray(113, 145).toString('hex'), padHex(evmWallet, { size: 32 }).slice(2));
    assert.equal(BigInt('0x' + packet.subarray(145).toString('hex')), 100n * 10n ** 18n);
    console.log(`ORDER ${key} ↔ solana: quotes passed; Solana send and uint256 packet verified`);
  }
  const q = await quote('arbitrum', 'solana', fixture.evmHolder, fixture.solanaHolder, 123n);
  const tx = q.userSteps.at(-1).transaction.encoded;
  await client('arbitrum').call({ account: fixture.evmHolder, to: tx.to, data: tx.data, value: BigInt(tx.value),
    stateOverride: [{ address: fixture.evmHolder, balance: 10n ** 20n }] });
  console.log('ORDER Arbitrum → Solana unsigned send passed; only native gas balance overridden');
} finally {
  Connection.prototype.simulateTransaction = simulate;
}
