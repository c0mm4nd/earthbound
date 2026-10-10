// Mainnet reads and unsigned calldata construction only. No signing or broadcasts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createPublicClient, http, decodeFunctionData, decodeAbiParameters, parseAbiParameters, toHex } from 'viem';
import { PublicKey, Connection, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
if (process.env.LIVE_SUSDAI_OFT !== '1') {
  console.log('Set LIVE_SUSDAI_OFT=1 to check sUSDai Arbitrum → Solana against mainnet.');
  process.exit(0);
}
const require = createRequire(import.meta.url);
function load(name) {
  const cjs = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: cjs, exports: cjs.exports, btoa, atob,
    require: (id) => id.startsWith('./') ? load(id.slice(2)) : require(id) });
  return cjs.exports;
}
const { buildDirectOftQuote } = load('direct-oft');
const { layerZeroOftV2Abi } = load('custom-oft');
const token = '0x0B2b2B2076d95dda7817e785989fE353fe955ef9';
const mint = 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE';
const to = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const from = '0x0000000000000000000000000000000000000001';
const nativeCurrency = { symbol: 'ETH', decimals: 18 };
const srcChain = { chainKey: 'arbitrum', chainId: 42161, chainType: 'EVM', shortName: 'Arbitrum', nativeCurrency };
const dstChain = { chainKey: 'solana', chainType: 'SOLANA', nativeCurrency: { symbol: 'SOL', decimals: 9 } };
const srcToken = { address: token, decimals: 18, symbol: 'sUSDai' };
const dstToken = { address: mint, decimals: 6, symbol: 'sUSDai' };
const client = createPublicClient({ transport: http('https://arb1.arbitrum.io/rpc', { timeout: 15000, retryCount: 0 }) });
let discoveryCalls = 0;
let apiResult;
const direct = await buildDirectOftQuote({ metadata: {}, srcChain, dstChain, srcToken, dstToken, from, to,
  amount: 10n ** 18n, discoverPeers: true,
  read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }),
  fetchDiscoveryQuote: async () => {
    discoveryCalls++;
    const response = await fetch('https://earthbound.web3resear.ch/api/bridge/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      provider: 'stargate', srcChainKey: 'arbitrum', dstChainKey: 'solana', srcTokenAddress: token, dstTokenAddress: mint,
      srcWalletAddress: from, dstWalletAddress: to, amount: (10n ** 18n).toString(),
      options: { amountType: 'EXACT_SRC_AMOUNT', feeTolerance: { type: 'PERCENT', amount: 0.5 }, dstNativeDropAmount: '0' },
    }) });
    assert.equal(response.ok, true);
    apiResult = await response.json();
    return apiResult;
  },
});
assert.equal(discoveryCalls, 1);
const result = apiResult.quotes[0];
assert.ok(result, 'A compatible API route is available');
assert.ok(BigInt(result.dstAmount) > 0n);
const envelope = result.userSteps.find((step) => step.transaction?.encoded?.data?.startsWith('0x571d3dc7')).transaction.encoded.data;
const [calls] = decodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[],bytes32'), `0x${envelope.slice(10)}`);
const send = calls.find((call) => call.target.toLowerCase() === '0xffb20098fd7b8e84762eea4609f299d101427f24');
assert.ok(send);
const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: send.callData });
assert.equal(decoded.functionName, 'send');
assert.equal(decoded.args[0].dstEid, 30168);
assert.equal(decoded.args[0].to, toHex(new PublicKey(to).toBytes()));
const directSend = direct.userSteps.at(-1).transaction.encoded;
assert.equal(directSend.to.toLowerCase(), send.target.toLowerCase());
const directParams = decodeFunctionData({ abi: layerZeroOftV2Abi, data: directSend.data });
assert.equal(directParams.functionName, 'send');
assert.equal(directParams.args[0].dstEid, 30168);
assert.equal(directParams.args[0].to, decoded.args[0].to);
assert.equal(directParams.args[0].amountLD, 10n ** 18n);
assert.ok(BigInt(direct.dstAmount) >= BigInt(result.dstAmount));
assert.equal(directParams.args[0].composeMsg, '0x');
assert.equal(directParams.args[0].oftCmd, '0x');
console.log(JSON.stringify({ route: 'sUSDai Arbitrum → Solana', directDstAmount: direct.dstAmount, apiDstAmount: result.dstAmount, adapter: send.target, directFees: direct.fees.map(({type,amount})=>({type,amount})), discoveryCalls, signed: false }));

// Execute the official receive-account planner and ATA initialization in an
// unsigned simulation. This checks the deployed program's layout, ALTs, and
// Token-2022 account size without claiming end-to-end message delivery.
const connection = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
const storeKey = new PublicKey('2xVEUsPGGv9Fe3NFc4UmhWd7Y2Ni7MjiSCL8oQJ9bzLZ');
const rawStore = await connection.getAccountInfo(storeKey);
const { decodeConsoleOftStore } = load('direct-oft-solana-console');
const store = decodeConsoleOftStore(rawStore.data);
const escrow = PublicKey.findProgramAddressSync([Buffer.from('Escrow'), storeKey.toBuffer()], rawStore.owner)[0];
const recipient = new PublicKey(to);
const ata = getAssociatedTokenAddressSync(store.mint, recipient, true, store.tokenProgram);
const le = (n, size) => { const b = Buffer.alloc(size); if(size === 8) b.writeBigUInt64LE(BigInt(n)); else b.writeUInt32LE(n); return b; };
const amountSD = Buffer.alloc(8); amountSD.writeBigUInt64BE(1000000n);
const message = Buffer.concat([recipient.toBuffer(), amountSD]);
const instruction = new TransactionInstruction({ programId: rawStore.owner,
  keys: [storeKey, escrow, store.mint, ata, store.tokenProgram, rawStore.owner, rawStore.owner, ...store.alts]
    .map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
  data: Buffer.concat([createHash('sha256').update('global:lz_receive_types_v2').digest().subarray(0,8),
    le(30110,4), Buffer.from(send.target.slice(2).padStart(64,'0'),'hex'), le(1,8), Buffer.alloc(32), le(message.length,4), message, le(0,4)]),
});
assert.ok(await connection.getBalance(store.initializer) > 3000000, 'Simulation fee payer must already have SOL; no funding is performed');
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: store.initializer,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  instructions: [createAssociatedTokenAccountIdempotentInstruction(store.initializer, ata, recipient, store.mint, store.tokenProgram), instruction],
}).compileToV0Message());
const simulation = await connection.simulateTransaction(tx, { sigVerify: false, accounts: { encoding: 'base64', addresses: [ata.toBase58()] } });
assert.equal(simulation.value.err, null, JSON.stringify(simulation.value.logs));
assert.equal(simulation.value.returnData.programId, rawStore.owner.toBase58());
const ataSize = Buffer.from(simulation.value.accounts[0].data[0], 'base64').length;
assert.equal(ataSize, 179, 'ImmutableOwner, TransferHookAccount and PausableAccount are required');
console.log(JSON.stringify({ receivePlanningSimulation: 'passed', ataSize, units: simulation.value.unitsConsumed, signed: false, broadcast: false }));
