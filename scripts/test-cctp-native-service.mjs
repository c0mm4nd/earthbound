import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as viem from 'viem';
import { createLoader } from './helpers/load-ts.mjs';
import { StrKey } from '@stellar/stellar-sdk';
const payer = '0x1111111111111111111111111111111111111111';
const recipient = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 42));
let allowance = 5n, chainId = 1, simulationFails = false;
const calls = [], requests = [];
const baseLoad = createLoader(), c = baseLoad('cctp-evm').cctpEvm(0);
const remote = baseLoad('cctp-native-proof').cctpWireMessenger(27);
const client = {
  getChainId: async () => chainId,
  readContract: async ({ functionName }) => ({ localDomain: 0, remoteTokenMessengers: remote, paused: false, localMessageTransmitter: c.transmitter, signatureThreshold: 2n, allowance })[functionName],
  call: async tx => { calls.push(tx); if (simulationFails) throw Error('simulation failed'); return {}; },
};
const load = createLoader({
  viem: { ...viem, createPublicClient: () => client },
  './cctp-stellar-monitor': { createCctpStellarMonitor: () => ({ attesters: async () => ({ domain: 27, threshold: 2, enabledAttesters: [] }) }) },
}, { fetch: async url => { requests.push(url); if (url.includes('/fees/')) return Response.json([{ finalityThreshold: 2000, minimumFee: '0' }]); throw Error('Unexpected request'); } });
const { prepareNativeCctp } = load('cctp-native-service');
const t = { sourceDomain: 0, destinationDomain: 27, sender: payer, recipient, amount: '1000000', maxFee: '0', finality: 2000, state: 'preparing' };

test('EVM to Stellar uses exact reset/approval, then canonical forwarder hook and simulated burn', async () => {
  const reset = await prepareNativeCctp(t, 'prepare', payer);
  assert.equal(reset.prerequisite, true);
  assert.equal(viem.decodeFunctionData({ abi: viem.erc20Abi, data: reset.step.transaction.encoded.data }).args[1], 0n);
  allowance = 0n;
  const approve = await prepareNativeCctp(t, 'prepare', payer);
  assert.equal(approve.prerequisite, true);
  assert.equal(viem.decodeFunctionData({ abi: viem.erc20Abi, data: approve.step.transaction.encoded.data }).args[1], 1000000n);
  await assert.rejects(() => prepareNativeCctp(t, 'burn', payer), /approval/);
  allowance = 1000000n;
  const burn = await prepareNativeCctp(t, 'prepare', payer);
  assert.equal(burn.prerequisite, false); assert.equal(burn.step.chainKey, 'ethereum');
  const decoded = viem.decodeFunctionData({ abi: load('cctp-evm').CCTP_ABI, data: burn.step.transaction.encoded.data });
  assert.equal(decoded.functionName, 'depositForBurnWithHook');
  const target = load('cctp-native').cctpMintTarget(27, recipient);
  assert.equal(decoded.args[2], target.mintRecipient); assert.equal(decoded.args[4], target.destinationCaller); assert.equal(decoded.args[7], target.hook);
  assert.equal(calls.length, 3, 'simulate reset, approval and actual burn before signing');
});

test('changed account, network, pending intent and failed simulation stop plans before signing', async () => {
  await assert.rejects(() => prepareNativeCctp(t, 'prepare', '0x2222222222222222222222222222222222222222'), /wallet/);
  await assert.rejects(() => prepareNativeCctp({ ...t, state: 'burn_pending' }, 'prepare', payer), /recovery/);
  chainId = 8453; await assert.rejects(() => prepareNativeCctp(t, 'prepare', payer), /mainnet/); chainId = 1;
  simulationFails = true; await assert.rejects(() => prepareNativeCctp(t, 'prepare', payer), /simulation/); simulationFails = false;
});
