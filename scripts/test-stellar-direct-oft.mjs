// Stellar address, recipient and credit-policy tests. No signed transactions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as sdk from '@stellar/stellar-sdk';
import { padHex, toHex, createPublicClient, http, decodeFunctionData } from 'viem';
const require = createRequire(import.meta.url);
function load(name, overrides = {}) {
  const m = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: m, exports: m.exports, Buffer, Uint8Array, atob, btoa, AbortSignal, fetch,
    setTimeout: overrides.setTimeout ?? setTimeout,
    require: id => overrides[id] ?? (id.startsWith('./') ? load(id.slice(2), overrides) : require(id)),
  });
  return m.exports;
}
const { stellarAddressBytes32, stellarContractAddress } = load('stellar-address');
const payload = new Uint8Array(32).fill(1), account = sdk.StrKey.encodeEd25519PublicKey(payload), contract = sdk.StrKey.encodeContract(payload);
assert.equal(stellarAddressBytes32(account, 'account'), toHex(payload));
assert.equal(stellarAddressBytes32(contract, 'contract'), toHex(payload));
assert.equal(stellarContractAddress(toHex(payload)), contract);
assert.throws(() => stellarAddressBytes32(account, 'contract'), /type/);
assert.throws(() => stellarAddressBytes32(account.slice(0, -1) + 'A'), /checksum/);
assert.throws(() => stellarAddressBytes32(account.toLowerCase()), /Enter/);
assert.throws(() => stellarAddressBytes32('M' + account.slice(1)), /muxed/);
assert.throws(() => stellarAddressBytes32(sdk.StrKey.encodeEd25519PublicKey(Buffer.alloc(32))), /zero/);
const token = sdk.StrKey.encodeContract(new Uint8Array(32).fill(2));
const minter = sdk.StrKey.encodeContract(new Uint8Array(32).fill(3));
const reversePeer = padHex('0x1234', { size: 32 });
const args = { chainType: 'STELLAR', address: toHex(payload), token, recipient: account, remoteEid: 30101, amountLD: '10000000' };
let paused = false, exists = false, missingTrustline = false, creditCalls = 0, quantity, simulateError, oftType = 'MintBurn';
class Server {
  async simulateTransaction(tx) {
    const invoke = tx.operations[0].func.invokeContract;
    const method = Buffer.from(invoke.functionName.bytes).toString();
    const params = invoke.args.map(sdk.scValToNative);
    if (simulateError) throw new Error('RPC unavailable');
    let retval;
    if (method === 'token') retval = sdk.nativeToScVal(token, { type: 'address' });
    else if (method === 'peer') retval = sdk.nativeToScVal(Buffer.from(reversePeer.slice(2), 'hex'), { type: 'bytes' });
    else if (method === 'is_paused') retval = sdk.nativeToScVal(paused);
    else if (method === 'shared_decimals') retval = sdk.nativeToScVal(6, { type: 'u32' });
    else if (method === 'decimals') retval = sdk.nativeToScVal(7, { type: 'u32' });
    else if (method === 'rate_limit_capacity') retval = sdk.nativeToScVal(10000000n, { type: 'i128' });
    else if (method === 'balance') retval = sdk.nativeToScVal(100n, { type: 'i128' });
    else if (method === 'oft_type') retval = sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvSymbol(oftType), ...(oftType === 'MintBurn' ? [sdk.nativeToScVal(minter, { type: 'address' })] : [])]);
    else if (method === 'mint' || method === 'transfer') {
      creditCalls++; quantity = params[method === 'mint' ? 1 : 2];
      if (missingTrustline) return { error: 'trustline entry is missing for account', latestLedger: 1 };
      retval = sdk.xdr.ScVal.scvVoid();
    } else assert.fail('Unexpected contract invocation: ' + method);
    return { transactionData: {}, result: { retval, auth: [] }, latestLedger: 1 };
  }
  async getLedgerEntries() { return { entries: exists ? [{}] : [] }; }
}
const mocked = { '@stellar/stellar-sdk': { ...sdk, rpc: { ...sdk.rpc, Server } }, setTimeout: cb => setTimeout(cb, 0) };
const { readStellarReceiveState } = load('direct-oft-stellar', mocked);
const state = await readStellarReceiveState(args);
assert.equal(state.peer, reversePeer);
assert.equal(state.sharedDecimals, 6); assert.equal(state.decimals, 7);
assert.equal(quantity, 10000000n);
assert.equal(creditCalls, 1);
paused = true;
await assert.rejects(readStellarReceiveState(args), /paused/); paused = false;
missingTrustline = true;
await assert.rejects(readStellarReceiveState(args), /trustline/); missingTrustline = false;
exists = true;
await assert.rejects(readStellarReceiveState(args), /different address type/);
await readStellarReceiveState({ ...args, recipient: contract }); exists = false;
await assert.rejects(readStellarReceiveState({ ...args, recipient: contract }), /different address type/);
await assert.rejects(readStellarReceiveState({ ...args, amountLD: '10000001' }), /capacity/);
oftType = 'LockUnlock';
await assert.rejects(readStellarReceiveState(args), /capacity/);
await readStellarReceiveState({ ...args, amountLD: '100' });
assert.equal(quantity, 100n);
simulateError = true;
await assert.rejects(readStellarReceiveState(args), /RPC unavailable/);
console.log('Stellar StrKey, address type resolution, peer, decimals, pause, trustline, exact-amount credit simulation, escrow capacity and RPC failure guards passed.');

if (process.env.LIVE_STELLAR_OFT !== '1') process.exit(0);
const origin = process.env.BRIDGE_TEST_ORIGIN ?? 'https://earthbound.web3resear.ch';
const get = async path => { const r = await fetch(origin + path); assert.ok(r.ok); return r.json(); };
const [{ chains }, { tokens }] = await Promise.all([get('/api/bridge/chains?provider=stargate'), get('/api/bridge/tokens?provider=stargate')]);
const { buildDirectOftQuote, directOftRecipient } = load('direct-oft');
const { readNonEvmReceiveState } = load('direct-oft-receive-state');
const { layerZeroOftV2Abi } = load('custom-oft');
const srcChain = chains.find(c => c.chainKey === 'ethereum'), dstChain = chains.find(c => c.chainKey === 'stellar');
const client = createPublicClient({ transport: http('https://ethereum-rpc.publicnode.com', { timeout: 15000 }) });
const stellar = new sdk.rpc.Server('https://soroban-rpc.mainnet.stellar.gateway.fm');
for (const symbol of ['USDe', 'ENA', 'sUSDe', 'USDT', 'PYUSD']) {
  const srcToken = tokens.find(t => t.chainKey === 'ethereum' && t.symbol === symbol), dstToken = tokens.find(t => t.chainKey === 'stellar' && t.symbol === symbol);
  const tx = new sdk.TransactionBuilder(new sdk.Account(account, '0'), { fee: '100', networkPassphrase: sdk.Networks.PUBLIC })
    .addOperation(new sdk.Contract(dstToken.address).call('name')).setTimeout(30).build();
  const nameResult = await stellar.simulateTransaction(tx);
  assert.ok(sdk.rpc.Api.isSimulationSuccess(nameResult));
  const asset = sdk.scValToNative(nameResult.result.retval);
  // Use a public holder with an existing trustline for unsigned simulation only.
  const holders = await fetch('https://horizon.stellar.org/accounts?asset=' + encodeURIComponent(asset) + '&limit=1').then(r => r.json());
  const to = holders._embedded?.records?.[0]?.account_id;
  assert.ok(to, 'A funded trustline is available for read-only validation');
  const amount = 10n * 10n ** BigInt(srcToken.decimals), from = '0x1111111111111111111111111111111111111111';
  const payload = { provider: 'stargate', srcChainKey: 'ethereum', dstChainKey: 'stellar', srcTokenAddress: srcToken.address, dstTokenAddress: dstToken.address,
    srcWalletAddress: from, dstWalletAddress: to, amount: amount.toString(), options: { amountType: 'EXACT_SRC_AMOUNT', feeTolerance: { type: 'PERCENT', amount: 0.5 }, dstNativeDropAmount: '0' } };
  const r = await fetch(origin + '/api/bridge/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const api = await r.json(); assert.ok(r.ok, JSON.stringify(api)); assert.ok(api.quotes.length);
  const quote = await buildDirectOftQuote({ metadata: {}, srcChain, dstChain, srcToken, dstToken, amount, from, to, discoverPeers: true,
    fetchDiscoveryQuote: async () => api, loadReceiveState: readNonEvmReceiveState,
    read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }),
  });
  const encoded = quote.userSteps.at(-1).transaction.encoded;
  const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: encoded.data });
  assert.equal(decoded.functionName, 'send'); assert.equal(decoded.args[0].dstEid, 30600);
  assert.equal(decoded.args[0].to, directOftRecipient('STELLAR', to));
  assert.equal(decoded.args[0].composeMsg, '0x'); assert.equal(decoded.args[0].oftCmd, '0x');
  assert.equal(quote.dstAmount, '100000000');
  assert.ok(BigInt(quote.dstAmount) >= BigInt(api.quotes[0].dstAmount));
  console.log(JSON.stringify({ route: 'Ethereum → Stellar', symbol, direct: quote.dstAmount, api: api.quotes[0].dstAmount, target: encoded.to, unsignedCreditSimulation: true, broadcast: false }));
}
