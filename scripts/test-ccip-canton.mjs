import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-ts.mjs';
import { CantonChain, EVMChain } from '@chainlink/ccip-sdk';
import { keccak256, stringToHex } from 'viem';
const load = createLoader();
const { isCcipAddress, ccipAddressKey, isCcipTransactionHash } = load('ccip-addresses');
const { ccipMessageEncoding } = load('ccip-message');
const { cantonPrimaryAccount, assertCantonCommandParty } = load('canton-wallet');
const party = 'alice::1220' + 'a'.repeat(64);
assert.ok(isCcipAddress('CANTON', party));
assert.notEqual(ccipAddressKey(party), ccipAddressKey(party.replace('alice', 'Alice')));
for (const value of ['0x' + 'a'.repeat(64), party + '::USD1', ' ' + party, 'alice::1220abc']) assert.equal(isCcipAddress('CANTON', value), false);
const encoded = ccipMessageEncoding('EVM', 'CANTON', party);
assert.equal(encoded.receiver, keccak256(stringToHex(party)), 'Canton recipient is a hash of the full party ID');
assert.equal(encoded.extraArgs, EVMChain.encodeExtraArgs(CantonChain.buildMessageForDest({ receiver: party }).extraArgs));
assert.ok(isCcipTransactionHash('CANTON', '1220' + 'b'.repeat(64)));
assert.equal(isCcipTransactionHash('EVM', '1220' + 'b'.repeat(64)), false);
const account = { partyId: party, primary: true, status: 'allocated', networkId: 'canton:da-mainnet', disabled: false };
assert.equal(cantonPrimaryAccount([account]).partyId, party);
for (const override of [{ primary: false }, { disabled: true }, { status: 'initialized' }, { networkId: 'canton:da-testnet' }]) assert.throws(() => cantonPrimaryAccount([{ ...account, ...override }]));
const commands = { commandId: 'reviewed', commands: [{ ExerciseCommand: {} }], actAs: [party] };
assertCantonCommandParty(commands, party);
for (const override of [{ actAs: [] }, { actAs: [party, 'other'] }, { readAs: ['other'] }, { commandId: '' }, { commands: [] }]) assert.throws(() => assertCantonCommandParty({ ...commands, ...override }, party));
// Keep both directions unavailable until participant and settlement integration
// is complete, even when the public directory advertises a valid token lane.
const evmToken = '0x' + '1'.repeat(40);
const cantonToken = '0x' + '2'.repeat(64);
const directoryChains = { data: {
  evm: { 1: { chainId: 1, displayName: 'Ethereum', internalId: 'ethereum-mainnet', selector: '5009297550715157269', router: '0x' + '3'.repeat(40), supported: true } },
  canton: { canton: { displayName: 'Canton', internalId: 'canton-mainnet', selector: '2308837218439511688', router: 'router@' + party, supported: true } },
} };
const directoryTokens = { data: { USD1: {
  1: { tokenAddress: evmToken, decimals: 18, symbol: 'USD1', name: 'USD1', destinations: ['canton'] },
  canton: { tokenAddress: cantonToken, decimals: 10, symbol: 'USD1', name: 'USD1', destinations: ['1'] },
} } };
const requests = [];
const gatedApi = createLoader({}, { fetch: async url => {
  requests.push(String(url));
  if (url.includes('/chains?')) return Response.json(directoryChains);
  if (url.includes('/tokens?')) return Response.json(directoryTokens);
  if (url.includes('transfer.layerzero-api.com')) return Response.json({ chains: [] });
  if (url === 'https://app.transporter.io/') return new Response('', { status: 503 });
  throw new Error('Unexpected execution or fee request: ' + url);
} })('ccip-api');
for (const outbound of [true, false]) {
  await assert.rejects(gatedApi.getCcipQuote({
    srcChainKey: outbound ? 'ccip-canton-mainnet' : 'ccip-ethereum-mainnet',
    dstChainKey: outbound ? 'ccip-ethereum-mainnet' : 'ccip-canton-mainnet',
    srcTokenAddress: outbound ? cantonToken : evmToken,
    dstTokenAddress: outbound ? evmToken : cantonToken,
    dstWalletAddress: outbound ? evmToken : party,
    amount: '1000000000000000000',
  }), /Canton transfers are in development/);
}
assert.equal(requests.filter(url => /getFee|getTotalFees|\/view/.test(url)).length, 0);
console.log('CCIP Canton unit: party IDs, official codec parity, mainnet account selection, acting-party binding and both-direction development gates passed. Full CCIP execution remains gated.');
