import { readFileSync } from 'node:fs';
import { sizedCoder } from '@chainlink/ccip-sdk/dist/solana/coder.js';
// Adapt only the IDL schema version to the already installed Anchor 0.29 coder.
// Field types, order and account metadata remain from Circle's pinned V2 IDL.
export function circleCoder(name) {
  const official = JSON.parse(readFileSync(new URL(`../fixtures/cctp-${name}.json`, import.meta.url), 'utf8'));
  const convert = value => Array.isArray(value) ? value.map(convert) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'defined' && typeof v === 'object' ? v.name : convert(v)]))
    : value === 'pubkey' ? 'publicKey' : value;
  const idl = convert(official);
  idl.accounts = []; idl.events = [];
  for (const ix of idl.instructions) ix.name = ix.name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return { official, coder: sizedCoder(idl) };
}
