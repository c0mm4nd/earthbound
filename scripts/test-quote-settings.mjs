import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader } from "./helpers/load-ts.mjs";

const { parseSlippagePercent, parseQuoteSettings, passesQuoteSlippage, formatQuoteSlippage } = createLoader()("quote-settings");
const quote = (expected = "10000", minimum = "9950") => ({ dstAmount: expected, dstAmountMin: minimum });

test("percentage input distinguishes no limit from zero and validates precision/range", () => {
  for (const [input, expected] of [["", null], ["  ", null], ["0", 0], ["0.01", 1], ["0.5", 50], ["1.25", 125], ["100", 10000]]) {
    assert.equal(parseSlippagePercent(input), expected);
  }
  for (const input of ["-1", "100.01", "0.001", "NaN", "Infinity", "1e2", "text"]) assert.throws(() => parseSlippagePercent(input));
});

test("filter includes the exact boundary and excludes even one base unit over it", () => {
  assert.equal(passesQuoteSlippage(quote(), 50), true);
  assert.equal(passesQuoteSlippage(quote("10000", "9949"), 50), false);
  const expected = 10n ** 30n;
  const minimum = expected * 995n / 1000n;
  assert.equal(passesQuoteSlippage(quote(String(expected), String(minimum)), 50), true);
  assert.equal(passesQuoteSlippage(quote(String(expected), String(minimum - 1n)), 50), false);
});

test("gas, fees, input value and token decimals do not affect quote-internal slippage", () => {
  const expensive = { ...quote(), srcAmount: "100000000000000000000", feeUsd: "1000", feePercent: "90", fees: [{ amountUsd: "1000", type: "GAS" }] };
  assert.equal(passesQuoteSlippage(expensive, 50), true);
  assert.equal(formatQuoteSlippage(expensive), "0.5%");
  assert.equal(passesQuoteSlippage(quote("1000000000000000000", "995000000000000000"), 50), true);
});

test("missing, malformed or inconsistent receive amounts cannot pass an enabled filter", () => {
  for (const q of [{ dstAmount: "10000" }, quote("0", "0"), quote("-1", "0"), quote("1.5", "1"), quote("10000", "NaN"), quote("10000", "10001")]) {
    assert.equal(passesQuoteSlippage(q, 50), false);
    assert.equal(passesQuoteSlippage(q, null), true);
    assert.equal(formatQuoteSlippage(q), "Unavailable");
  }
});

test("zero only permits exact output; invalid thresholds fail closed", () => {
  assert.equal(passesQuoteSlippage(quote("100", "100"), 0), true);
  assert.equal(passesQuoteSlippage(quote("100", "99"), 0), false);
  assert.equal(passesQuoteSlippage(quote("100", "0"), 10000), true);
  for (const limit of [-1, NaN, Infinity, 0.5, 10001]) assert.equal(passesQuoteSlippage(quote(), limit), false);
});

test("display rounds up instead of disguising quotes just above the limit", () => {
  assert.equal(formatQuoteSlippage(quote("100000", "99499")), "0.51%");
  assert.equal(formatQuoteSlippage(quote("100", "100")), "0%");
});

test("stored settings round-trip and corrupted values fall back safely", () => {
  const saved = { useApiRoutes: true, maxSlippageBps: 50 };
  const parsed = parseQuoteSettings(JSON.stringify(saved));
  assert.equal(parsed.useApiRoutes, true);
  assert.equal(parsed.maxSlippageBps, 50);
  assert.equal(parseQuoteSettings('{"maxSlippageBps":0}').maxSlippageBps, 0);
  for (const value of [null, "broken", "null", '{"maxSlippageBps":-1}', '{"maxSlippageBps":"50"}']) {
    assert.equal(parseQuoteSettings(value).maxSlippageBps, null);
    assert.equal(parseQuoteSettings(value).useApiRoutes, false);
  }
});
