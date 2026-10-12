import { concatHex, encodeAbiParameters, encodeEventTopics, pad, toHex, zeroHash, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLoader } from './load-ts.mjs';
export const load = createLoader({}, { Error });
export const evm = load('cctp-evm');
export const sender = '0x1111111111111111111111111111111111111111';
export const recipient = '0x2222222222222222222222222222222222222222';
// Public deterministic test key, never funded or used on a public network.
export const attester = privateKeyToAccount(toHex(12345n, { size: 32 }));
export const transfer = { sourceDomain: 0, destinationDomain: 6, sender, recipient, amount: '100000000', maxFee: '10000', finality: 1000, state: 'preparing' };
export const burnHash = toHex(1n, { size: 32 }), claimHash = toHex(2n, { size: 32 });
export function message(t = transfer, attested = false) {
  const u32 = n => toHex(n, { size: 4 }), u256 = n => toHex(n, { size: 32 });
  return concatHex([u32(1), u32(t.sourceDomain), u32(t.destinationDomain), u256(attested ? 1234 : 0),
    pad(evm.cctpEvm(t.sourceDomain).messenger), pad(evm.cctpEvm(t.destinationDomain).messenger), zeroHash,
    u32(t.finality), u32(attested ? t.finality : 0), u32(1), pad(evm.cctpEvm(t.sourceDomain).usdc),
    pad(t.recipient), u256(BigInt(t.amount)), pad(t.sender), u256(BigInt(t.maxFee)), u256(attested ? BigInt(t.maxFee) : 0n), u256(0),
  ]).toLowerCase();
}
export function receipt(t = transfer) {
  return { status: 'success', transactionHash: burnHash, logs: [{ address: evm.cctpEvm(t.sourceDomain).transmitter,
    topics: encodeEventTopics({ abi: evm.CCTP_ABI, eventName: 'MessageSent' }),
    data: encodeAbiParameters([{ type: 'bytes' }], [message(t)]),
  }] };
}
export async function proof(t = transfer) {
  const raw = message(t, true);
  return { message: raw, attestation: await attester.sign({ hash: keccak256(raw) }) };
}
export function iris(p) { return { messages: [{ ...p, status: 'complete', cctpVersion: 2 }] }; }
export function client(domain, overrides = {}) {
  const c = evm.cctpEvm(domain), remote = evm.cctpEvm(domain === 0 ? 6 : 0);
  return {
    getChainId: async () => c.chainId,
    getTransactionReceipt: async () => receipt(),
    getBlockNumber: async () => 1n,
    call: async () => ({ data: '0x' }),
    readContract: async ({ functionName, args }) => {
      switch (functionName) {
        case 'localDomain': return domain;
        case 'localMessageTransmitter': return c.transmitter;
        case 'remoteTokenMessengers': return pad(remote.messenger);
        case 'paused': return false;
        case 'localMinter': return c.messenger;
        case 'burnLimitsPerMessage': case 'balanceOf': return 1000000000000n;
        case 'allowance': case 'usedNonces': return 0n;
        case 'signatureThreshold': return 1n;
        case 'isEnabledAttester': return args[0] === attester.address.toLowerCase();
        default: throw Error('Unexpected contract read: ' + functionName);
      }
    },
    ...overrides,
  };
}
