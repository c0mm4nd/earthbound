import type { BridgeQuote } from "./bridge-types";

export const QUOTE_SETTINGS_KEY = "earthbound.quote_settings.v1";
export interface QuoteSettings {
  useApiRoutes: boolean;
  maxSlippageBps: number | null;
}
export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  useApiRoutes: false,
  maxSlippageBps: null,
};

export function parseSlippagePercent(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Enter 0–100%, with up to two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps > 10_000) throw new Error("Enter a percentage between 0 and 100.");
  return bps;
}

export function parseQuoteSettings(value: string | null): QuoteSettings {
  try {
    const saved = JSON.parse(value ?? "null");
    const limit = saved?.maxSlippageBps;
    return {
      useApiRoutes: saved?.useApiRoutes === true,
      maxSlippageBps: Number.isInteger(limit) && limit >= 0 && limit <= 10_000 ? limit : null,
    };
  } catch {
    return { ...DEFAULT_QUOTE_SETTINGS };
  }
}

// Both quantities are in destination-token base units. Gas and fees never enter this ratio.
export function getQuoteSlippage(quote: Pick<BridgeQuote, "dstAmount" | "dstAmountMin">) {
  if (!/^\d+$/.test(quote.dstAmount) || !quote.dstAmountMin || !/^\d+$/.test(quote.dstAmountMin)) return null;
  const expected = BigInt(quote.dstAmount);
  const minimum = BigInt(quote.dstAmountMin);
  if (expected <= BigInt(0) || minimum > expected) return null;
  return { expected, difference: expected - minimum };
}

export function passesQuoteSlippage(quote: BridgeQuote, maxSlippageBps: number | null): boolean {
  if (maxSlippageBps === null) return true;
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) return false;
  const slippage = getQuoteSlippage(quote);
  return slippage !== null && slippage.difference * BigInt(10_000) <= slippage.expected * BigInt(maxSlippageBps);
}

export function formatQuoteSlippage(quote: BridgeQuote): string {
  const slippage = getQuoteSlippage(quote);
  if (!slippage) return "Unavailable";
  // Round up for display so a quote just over a threshold never appears to meet it.
  const bps = (slippage.difference * BigInt(10_000) + slippage.expected - BigInt(1)) / slippage.expected;
  return `${Number(bps) / 100}%`;
}
