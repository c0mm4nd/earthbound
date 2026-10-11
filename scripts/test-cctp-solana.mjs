import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { cctpNetwork, isCctpUsdc, buildCctpEstimates } = load('cctp');
const { normalizeCctpRecipient } = load('cctp-recipients');
const solana = cctpNetwork(5);
assert.equal(solana.family, 'SOLANA');
assert.equal(isCctpUsdc(solana, solana.usdc), true);
assert.equal(isCctpUsdc(solana, solana.usdc.toLowerCase()), false);
assert.equal(normalizeCctpRecipient('SOLANA', solana.usdc), solana.usdc);
for (const address of ['11111111111111111111111111111111', '0x1', 'O'.repeat(44)]) {
  assert.throws(() => normalizeCctpRecipient('SOLANA', address));
}
const quotes = buildCctpEstimates({ sourceDomain: 5, destinationDomain: 0, sourceToken: solana.usdc, destinationToken: cctpNetwork(0).usdc, amount: '1.000001' }, [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }]).quotes;
assert.equal(quotes.length, 2);
assert.equal(quotes[0].protocolFee, '101');
assert.equal(quotes[1].destinationAmount, '1000001');
console.log('CCTP Solana: case-sensitive mint identity, base58 recipients and exact fee estimates passed; execution remains disabled.');
