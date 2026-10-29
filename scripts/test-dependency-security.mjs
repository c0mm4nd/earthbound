import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';
import { Address } from '@ton/core';

const require = createRequire(import.meta.url);

for (const entry of ['deepmerge', 'deepmerge/dist/umd.js']) {
  test(`${entry}: untrusted keys cannot change the merged prototype`, () => {
    const merge = require(entry);
    const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"ok":1}');
    for (const [target, source] of [
      [Object.create(null), malicious],
      [{ session: null }, { session: malicious }],
      [malicious, {}],
    ]) {
      const result = merge(target, source);
      const value = result.session ?? result;
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
      assert.equal(value.isAdmin, undefined);
      assert.equal(Object.hasOwn(value, '__proto__'), false);
      assert.equal(Object.hasOwn(value, 'constructor'), false);
    }
    assert.deepEqual(merge({ a: { b: 1 }, list: [1] }, { a: { c: 2 }, list: [2] }), {
      a: { b: 1, c: 2 }, list: [1, 2],
    });
    assert.equal({}.isAdmin, undefined);
  });
}

test('elliptic preserves leading zero bytes in the RFC 6979 nonce', () => {
  const { ec: EC } = require('elliptic');
  const ec = new EC('p521');
  const digest = createHash('sha512').update('earthbound nonce regression 20').digest();
  // Public test scalar 1. Expected deterministic signature independently computed
  // with @noble/curves 1.9.1 p521.sign(digest, 1n, { lowS: false, prehash: false }).
  // Unpatched elliptic 6.6.1 produces different r and s for this leading-zero case.
  const signature = ec.sign(digest, '1', { canonical: false });
  assert.equal(signature.r.toString(16), '544319a1b38b1ee0fc5b09828104e3a7f6164e3fd4830d660d1f18a762024b89be54c2dffa349eee594e587dc5792ed9633d69a90745232436fb23128329dfb332');
  assert.equal(signature.s.toString(16), '4075aefd280609218c7a0bff3b455d144f23bc2f7cb074f3310ae2fc9b58ba9fd1a0bafd3a5d00a2a4dc5df3158a3d5cb2a1d51f0b6d8ac233c360ebbe3a8185aa');
  assert.equal(ec.verify(digest, signature, ec.keyFromPrivate('1')), true);
});

test('Solana integer encodings round-trip without native bigint-buffer bindings', () => {
  const scopedRequire = createRequire(require.resolve('@solana/buffer-layout-utils'));
  const bigint = scopedRequire('bigint-buffer');
  assert.equal(scopedRequire('bigint-buffer/package.json').name, '@exodus/bigint-buffer');
  for (const width of [8, 16, 32]) {
    for (const value of [0n, 1n, 123456789n, (1n << BigInt(width * 8)) - 1n]) {
      for (const endian of ['LE', 'BE']) {
        const bytes = bigint[`toBuffer${endian}`](value, width);
        assert.equal(bytes.length, width);
        assert.equal(bigint[`toBigInt${endian}`](bytes), value);
      }
    }
  }
  assert.equal(bigint.toBigIntLE(Buffer.alloc(0)), 0n);
  // The original native conversion overflows on oversized buffers.
  assert.equal(bigint.toBigIntLE(Buffer.alloc(4096, 0xff)), (1n << 32768n) - 1n);
  const { u64 } = require('@solana/buffer-layout-utils');
  const bytes = Buffer.alloc(8);
  u64().encode(18446744073709551615n, bytes, 0);
  assert.equal(u64().decode(bytes, 0), 18446744073709551615n);
});

test('Solana RPC works with the updated Jayson browser client', async () => {
  let request;
  const connection = new Connection('https://rpc.invalid', {
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: 12345 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(await connection.getBalance(PublicKey.default), 12345);
  assert.equal(request.method, 'getBalance');
  assert.match(request.id, /^[0-9a-f-]{36}$/);
});

for (const parent of ['@layerzerolabs/lz-ton-sdk-v2', '@chainlink/ccip-sdk']) {
  test(`${parent}: TON transaction options validate with Zod 4`, async () => {
    const scopedRequire = createRequire(require.resolve(parent));
    const { TonClient4 } = scopedRequire('@ton/ton');
    let optionValue = '1000';
    const client = new TonClient4({
      endpoint: 'https://rpc.invalid',
      httpAdapter: async (config) => ({
        config, status: 200, statusText: 'OK', headers: {},
        data: { blocks: [], transactions: [{
          address: 'test', lt: '1', hash: 'test', prevTransaction: { lt: '0', hash: 'test' },
          time: 1, outMessagesCount: 0, oldStatus: 'active', newStatus: 'active', fees: '0',
          update: { oldHash: 'test', newHash: 'test' }, inMessage: null, outMessages: [],
          parsed: { seqno: 1, body: null, status: 'success', dest: null, kind: 'out',
            amount: '0', resolvedAddress: 'test', bounced: false, mentioned: [] },
          operation: { address: 'test', items: [], op: {
            type: 'jetton::transfer', options: { amount: optionValue },
          } },
        }] },
      }),
    });
    const address = new Address(0, Buffer.alloc(32));
    const result = await client.getAccountTransactionsParsed(address, 1n, Buffer.alloc(32));
    assert.equal(result.transactions[0].operation.op.options.amount, '1000');
    optionValue = 1000;
    await assert.rejects(client.getAccountTransactionsParsed(address, 1n, Buffer.alloc(32)), /response/i);
  });
}

test('Anchor TOML workspace parsing retains its parse API', () => {
  const scopedRequire = createRequire(require.resolve('@coral-xyz/anchor'));
  const toml = scopedRequire('toml');
  const result = toml.parse('[provider]\ncluster = "localnet"\n[programs.localnet]\nbridge = "test"\n');
  assert.equal(result.provider.cluster, 'localnet');
  assert.equal(result.programs.localnet.bridge, 'test');
  const untrusted = toml.parse('[__proto__]\npolluted = true');
  assert.equal(untrusted.polluted, undefined);
  assert.equal(Object.hasOwn(untrusted, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
