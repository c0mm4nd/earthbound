import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { cctpNetwork, cctpUnits, buildCctpEstimates, parseCctpFeeRates, cctpFeeAmount } = load('cctp');
const { createCctpApi } = load('cctp-api');
const { CCTP_NETWORKS } = load('cctp-networks');
const { normalizeCctpRecipient } = load('cctp-recipients');
const request = {
  sourceDomain: 0, destinationDomain: 6, amount: '100',
  sourceToken: cctpNetwork(0).usdc, destinationToken: cctpNetwork(6).usdc,
};
const rates = [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }];

test('registry separates domains from chain IDs and excludes non-USDC/legacy domains', () => {
  assert.equal(CCTP_NETWORKS.length, 30);
  assert.equal(new Set(CCTP_NETWORKS.map(n => n.domain)).size, CCTP_NETWORKS.length);
  for (const id of [4, 17, 8453, '0', -1, NaN]) assert.throws(() => cctpNetwork(id), /Unsupported/);
  assert.equal(cctpNetwork(1).name, 'Avalanche');
  assert.equal(cctpNetwork(29).family, 'EVM');
});

test('standard/fast fee estimates are exact and never executable', () => {
  const response = buildCctpEstimates(request, rates, 100);
  assert.equal(response.executionReady, false);
  const [fast, standard] = response.quotes;
  assert.equal(fast.protocolFee, '10000');
  assert.equal(fast.destinationAmount, '99990000');
  assert.equal(standard.destinationAmount, '100000000');
  assert.equal(fast.expiresAt, 30100);
  for (const quote of response.quotes) {
    assert.equal(quote.executionReady, false);
    assert.equal(quote.userSteps, undefined);
    assert.equal(quote.gasIncluded, false);
    assert.equal(quote.forwardingIncluded, false);
    assert.equal(quote.fastAllowanceChecked, false);
  }
  assert.equal(cctpFeeAmount(10001n, '0.5'), 1n);
  assert.equal(cctpFeeAmount(900719925474099300n, '0.01'), 900719925475n);
  assert.equal(buildCctpEstimates(request, [{ finalityThreshold: 2000, minimumFee: 2 }]).quotes[0].protocolFee, '20000');
});

test('invalid inputs, forged USDC, small amounts and malformed fees fail closed', () => {
  for (const amount of [0, null, '', '-1', '1e3', '01', '0.0000001', 'Infinity', ' 1', '9'.repeat(80)]) {
    assert.throws(() => buildCctpEstimates({ ...request, amount }, rates));
  }
  assert.equal(cctpUnits('9007199254.740993', 6), 9007199254740993n);
  assert.throws(() => buildCctpEstimates({ ...request, destinationDomain: 0 }, rates), /different/);
  assert.throws(() => buildCctpEstimates({ ...request, sourceToken: 'USDC' }, rates), /native USDC/);
  assert.throws(() => buildCctpEstimates({ ...request, destinationToken: request.sourceToken }, rates), /native USDC/);
  const small = buildCctpEstimates({ ...request, amount: '0.000001' }, rates);
  assert.equal(small.quotes.length, 1);
  assert.equal(small.rejectedQuotes[0].mode, 'fast');
  for (const data of [null, {}, [], [rates[0], rates[0]], [{ finalityThreshold: 500, minimumFee: 0 }]]) {
    assert.throws(() => parseCctpFeeRates(data));
  }
  for (const minimumFee of [null, -1, NaN, Infinity, '1e-3', 10000, '0.0000001']) {
    assert.throws(() => parseCctpFeeRates([{ finalityThreshold: 2000, minimumFee }]));
  }
});

test('EVM recipients require a nonzero address and valid checksum', () => {
  assert.equal(normalizeCctpRecipient('EVM', '0x' + '1'.repeat(40)), '0x' + '1'.repeat(40));
  for (const recipient of ['0x0', '0x' + '0'.repeat(40), 'ethereum.eth', request.sourceToken.replace('A0', 'a0')]) {
    assert.throws(() => normalizeCctpRecipient('EVM', recipient));
  }
});

test('fee client deduplicates calls, expires cache and validates before networking', async () => {
  let calls = 0, clock = 0;
  const api = createCctpApi(async (url, options) => {
    calls++;
    assert.equal(url, 'https://iris-api.circle.com/v2/burn/USDC/fees/0/6');
    assert.equal(options.cache, 'no-store');
    return Response.json(rates);
  }, () => clock);
  await Promise.all([api.estimate(request), api.estimate({ ...request, amount: '200' })]);
  assert.equal(calls, 1);
  await api.estimate(request);
  assert.equal(calls, 1);
  clock = 10_001;
  await api.estimate(request);
  assert.equal(calls, 2);
  for (const bad of [{ sourceDomain: '0/../../x' }, { sourceToken: 'USDC.e' }, { recipient: 'wrong wallet' }]) {
    await assert.rejects(() => api.estimate({ ...request, ...bad }));
  }
  assert.equal(calls, 2);
});

test('upstream errors are not cached or turned into free estimates', async () => {
  let calls = 0;
  const api = createCctpApi(async () => {
    calls++;
    return calls === 1 ? Response.json({}, { status: 429 }) : Response.json(rates);
  });
  await assert.rejects(() => api.estimate(request), /429/);
  assert.equal((await api.estimate(request)).quotes.length, 2);
  assert.equal(calls, 2);
  const malformed = createCctpApi(async () => Response.json({ error: 'bad response' }));
  await assert.rejects(() => malformed.estimate(request), /Invalid Circle/);
});
