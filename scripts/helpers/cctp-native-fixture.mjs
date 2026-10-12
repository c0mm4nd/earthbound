import { createLoader } from './load-ts.mjs';
import { Keypair } from '@solana/web3.js';
import { StrKey } from '@stellar/stellar-sdk';
import * as stellarSdk from '@stellar/stellar-sdk';
import { pad, toHex } from 'viem';
// Keep XDR class identity consistent across the ESM tests and transpiled modules.
export const load = createLoader({ '@stellar/stellar-sdk': stellarSdk });
export const wallet = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58();
export const stellar = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 42));
export const evm = '0x1111111111111111111111111111111111111111';
export function intent(domain, overrides = {}) {
  return { sourceDomain: domain, destinationDomain: 0, sender: domain === 5 ? wallet : domain === 27 ? stellar : '0x123', recipient: evm,
    amount: '9007199254740993', maxFee: '10000', finality: 2000, ...overrides };
}
export function nativeProof(domain, recipient) {
  const { cctpMintTarget, CCTP_SOLANA, CCTP_STELLAR } = load('cctp-native');
  const target = cctpMintTarget(domain, recipient);
  const message = Buffer.alloc(376 + (target.hook.length - 2) / 2);
  message.writeUInt32BE(1, 0); message.writeUInt32BE(0, 4); message.writeUInt32BE(domain, 8);
  message[43] = 1; message.writeUInt32BE(2000, 140); message.writeUInt32BE(2000, 144); message.writeUInt32BE(1, 148);
  for (const [offset, hex] of [[108, target.destinationCaller], [184, target.mintRecipient], [216, pad(toHex(1000000))], [280, pad(toHex(100))], [376, target.hook]]) Buffer.from(hex.slice(2), 'hex').copy(message, offset);
  Buffer.from(load('cctp-native-proof').cctpWireMessenger(domain).slice(2), 'hex').copy(message, 76);
  if (domain === 27) Buffer.from(StrKey.decodeContract(CCTP_STELLAR.messenger)).copy(message, 76);
  return { message: toHex(message), attestation: '0x' + '11'.repeat(65), target, CCTP_SOLANA };
}
