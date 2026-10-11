import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-ts.mjs';
import { SolanaChain, EVMChain } from '@chainlink/ccip-sdk';
import { Keypair } from '@solana/web3.js';
import { decodeAbiParameters } from 'viem';
const load = createLoader();
const { ccipMessageEncoding } = load('ccip-message');
const { isCcipAddress, isCcipTransactionHash } = load('ccip-addresses');
const { ccipTransferKey, resolveCcipQuote, normalizeCcipQuote } = load('ccip');
const { ccipStatusQuery, normalizeCcipStatus } = load('ccip-status');
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const mint = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const evm = '0x1111111111111111111111111111111111111111';
const encoded = ccipMessageEncoding('EVM', 'SOLANA', recipient);
const canonical = SolanaChain.buildMessageForDest({ receiver: recipient, tokenAmounts: [{ token: evm, amount: 1n }] });
assert.equal(encoded.extraArgs, EVMChain.encodeExtraArgs(canonical.extraArgs), 'Solana destination encoding matches the independent official SDK');
assert.equal(encoded.receiver, '0x' + '0'.repeat(64), 'pure transfer must not invoke a recipient program');
const decoded = decodeAbiParameters([{ type: 'tuple', components: [{ type: 'uint32' }, { type: 'uint64' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes32[]' }] }], '0x' + encoded.extraArgs.slice(10))[0];
assert.equal(decoded[0], 0);
assert.equal(decoded[2], true);
assert.equal(decoded[4].length, 0);
assert.equal(ccipMessageEncoding('SOLANA', 'EVM', evm).extraArgs, SolanaChain.encodeExtraArgs({ gasLimit: 0n, allowOutOfOrderExecution: true }));
assert.ok(isCcipAddress('SOLANA', recipient));
for (const invalid of [evm, '1'.repeat(32), recipient + '0', ' ' + recipient]) assert.equal(isCcipAddress('SOLANA', invalid), false);
const request = { srcChainKey: 'solana', dstChainKey: 'ethereum', srcTokenAddress: mint, dstTokenAddress: evm, dstWalletAddress: evm, amount: '9007199254740993' };
assert.notEqual(ccipTransferKey(request, recipient), ccipTransferKey(request, recipient.toLowerCase()), 'Solana sender identities remain case sensitive');
assert.notEqual(ccipTransferKey(request, recipient), ccipTransferKey({ ...request, srcTokenAddress: mint.toLowerCase() }, recipient));
const chain = (key, family, selector, router, decimals) => ({ chainKey: key, chainId: 1, chainType: family, nativeCurrency: { chainKey: key, address: router, symbol: family === 'SOLANA' ? 'SOL' : 'ETH', decimals }, ccip: { selector, router, selectorName: key } });
const catalog = { chains: [chain('solana', 'SOLANA', '124615329519749607', recipient, 9), chain('ethereum', 'EVM', '5009297550715157269', evm, 18)], tokens: [
  { chainKey: 'solana', address: mint, decimals: 9, symbol: 'TEST', ccip: { destinations: [{ chainKey: 'ethereum', address: evm }] } },
  { chainKey: 'ethereum', address: evm, decimals: 18, symbol: 'TEST', ccip: { destinations: [] } },
] };
assert.equal(normalizeCcipQuote(catalog, request, { ccipFee: '15322000' }).quotes[0].dstAmount, '9007199254740993000000000');
assert.throws(() => resolveCcipQuote(catalog, { ...request, amount: (2n ** 64n).toString() }), /limit/);
const signature = '2'.repeat(88); // 64 decoded bytes
assert.ok(isCcipTransactionHash('SOLANA', signature));
assert.equal(isCcipTransactionHash('SOLANA', recipient), false);
const query = ccipStatusQuery('ccip:124615329519749607:5009297550715157269:1', signature);
const message = { sendTransactionHash: signature, messageId: '0x' + 'a'.repeat(64), sourceNetworkInfo: { chainSelector: '124615329519749607' }, destNetworkInfo: { chainSelector: '5009297550715157269' }, status: 'SUCCESS' };
assert.equal(normalizeCcipStatus({ data: [message] }, query).status, 'COMPLETED');
assert.equal(normalizeCcipStatus({ data: [{ ...message, sendTransactionHash: '3'.repeat(88) }] }, query).status, 'PENDING');
console.log('CCIP Solana unit: SDK encoding parity, no recipient callback, case-sensitive identity, u64 precision, signature validation and route-bound tracking passed.');

// Decode a real unsigned SDK build from public mainnet state. No private key or
// broadcast is involved. This catches instruction-layout and selector regressions.
const { readFileSync } = await import('node:fs');
const web3 = await import('@solana/web3.js');
const { sizedCoder } = await import('@chainlink/ccip-sdk/dist/solana/coder.js');
const { IDL } = await import('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ccip-solana.json', import.meta.url), 'utf8'));
const wire = fixture.step.transaction.encoded.serializedTransaction;
const transaction = web3.VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
assert.ok(transaction.serialize().length <= 1232);
assert.equal(transaction.message.header.numRequiredSignatures, 1);
assert.equal(transaction.message.staticAccountKeys[0].toBase58(), fixture.request.srcWalletAddress);
const routerInstructions = transaction.message.compiledInstructions.filter(ix => transaction.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === fixture.ccip.router);
assert.equal(routerInstructions.length, 1);
const instruction = sizedCoder(IDL).instruction.decode(Buffer.from(routerInstructions[0].data));
assert.equal(instruction.name, 'ccipSend');
assert.equal(instruction.data.destChainSelector.toString(), fixture.ccip.destinationSelector);
assert.equal(instruction.data.message.tokenAmounts[0].token.toBase58(), fixture.request.srcTokenAddress);
assert.equal(instruction.data.message.tokenAmounts[0].amount.toString(), fixture.request.amount);
assert.equal(instruction.data.message.receiver.toString('hex'), fixture.request.dstWalletAddress.slice(2).padStart(64, '0'));
assert.equal(instruction.data.message.data.length, 0);
assert.equal(instruction.data.message.feeToken.toBase58(), '11111111111111111111111111111111');
assert.equal(instruction.data.message.extraArgs.toString('hex'), ccipMessageEncoding('SOLANA', 'EVM', fixture.request.dstWalletAddress).extraArgs.slice(2));

let genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', payer = fixture.request.srcWalletAddress;
let signCount = 0, valid = true, simulationFailure = null;
const events = [];
const provider = { publicKey: { toBase58: () => payer }, signAndSendTransaction: async () => { signCount++; events.push('sign'); return { signature }; } };
class MockConnection {
  async getGenesisHash() { return genesis; }
  async isBlockhashValid() { return { value: valid }; }
  async simulateTransaction() { return { value: { err: simulationFailure } }; }
  async getSignatureStatuses() { events.push('confirmed'); return { value: [{ confirmationStatus: 'confirmed', err: null }] }; }
}
const walletLoad = createLoader({ '@solana/web3.js': { ...web3, Connection: MockConnection } }, { window: { solana: provider } });
const { executeSolanaUserSteps } = walletLoad('bridge-wallets');
assert.equal(await executeSolanaUserSteps([fixture.step], payer, undefined, () => events.push('persist'), () => events.push('guard')), signature);
assert.deepEqual(events, ['guard', 'sign', 'persist', 'confirmed'], 'persist source hash before waiting');
genesis = 'devnet';
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer), /mainnet/);
genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
valid = false;
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer), /expired/);
valid = true;
simulationFailure = { InstructionError: [0, 'Custom'] };
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer), /simulation failed/);
simulationFailure = null;
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer, undefined, undefined, () => { throw Error('changed'); }), /changed/);
payer = recipient;
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer), /wallet changed/);
assert.equal(signCount, 1, 'network, expiry, simulation, form and wallet failures prevent signing');
console.log('CCIP Solana execution unit: real mainnet instruction decode, atomic plan, wallet/network/expiry checks, simulation and persistence ordering passed.');
payer = fixture.request.srcWalletAddress;
delete provider.signAndSendTransaction;
provider.signTransaction = async tx => {
  const altered = web3.VersionedTransaction.deserialize(tx.serialize());
  altered.message.recentBlockhash = recipient;
  return altered;
};
await assert.rejects(() => executeSolanaUserSteps([fixture.step], payer), /changed the reviewed CCIP transaction/);
console.log('CCIP Solana signed-message mutation is rejected before broadcast.');

// Native 0G shares its existing W0G lane with Solana. SOL itself is not a
// cross-chain principal merely because it pays the source network fee.
const { CCIP_WRAPPED_NATIVE, addWrappedNativeRoutes } = load('ccip-wrapped-native');
const { assertCcipQuote, ccipMessage } = load('ccip-execution');
const { zeroAddress } = await import('viem');
const ogConfig = CCIP_WRAPPED_NATIVE[16661];
const ogChain = { chainId: 16661, chainKey: 'og', chainType: 'EVM', nativeCurrency: { address: zeroAddress, decimals: 18, symbol: '0G' }, ccip: { selector: ogConfig.selector, selectorName: 'og', router: ogConfig.router } };
const solChain = catalog.chains[0];
const nativeCatalog = addWrappedNativeRoutes({ chains: [ogChain, solChain], tokens: [
  { chainKey: 'og', address: ogConfig.token, decimals: 18, symbol: 'W0G', ccip: { destinations: [{ chainKey: 'solana', address: mint }] } },
  { chainKey: 'solana', address: mint, decimals: 9, symbol: 'W0G', ccip: { destinations: [{ chainKey: 'og', address: ogConfig.token }] } },
] });
const nativeToSol = { srcChainKey: 'og', dstChainKey: 'solana', srcTokenAddress: zeroAddress, dstTokenAddress: mint, srcWalletAddress: evm, dstWalletAddress: recipient, amount: '1000000000000000000' };
const outboundNative = normalizeCcipQuote(nativeCatalog, nativeToSol, { ccipFee: '1000' }).quotes[0];
assertCcipQuote(outboundNative, nativeToSol, ogChain);
assert.equal(outboundNative.dstAmount, '1000000000');
assert.equal(ccipMessage(outboundNative).tokenAmounts[0].token, ogConfig.token);
assert.equal(ccipMessage(outboundNative).extraArgs, ccipMessageEncoding('EVM', 'SOLANA', recipient).extraArgs);
const solToNative = { srcChainKey: 'solana', dstChainKey: 'og', srcTokenAddress: mint, dstTokenAddress: zeroAddress, srcWalletAddress: recipient, dstWalletAddress: evm, amount: '123456789' };
const inboundNative = normalizeCcipQuote(nativeCatalog, solToNative, { ccipFee: '1000' }).quotes[0];
assertCcipQuote(inboundNative, solToNative, solChain);
assert.equal(inboundNative.dstAmount, '123456789000000000');
assert.equal(inboundNative.ccip.wrapping.source, undefined);
assert.equal(inboundNative.ccip.wrapping.destination, ogConfig.token);
assert.equal(nativeCatalog.tokens.filter(t => t.chainKey === 'solana').length, 1, 'do not invent native SOL support');
console.log('CCIP Solana native-asset unit: real W0G lane semantics, 18/9 decimal conversion, source wrapped mint, unchanged recipient encoding and destination manual unwrap passed.');
