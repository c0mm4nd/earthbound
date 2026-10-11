import { buildCctpEstimates, parseCctpFeeRates, prepareCctpEstimate, type CctpFeeRate } from "./cctp";
import { normalizeCctpRecipient } from "./cctp-recipients";

const CIRCLE_API = "https://iris-api.circle.com";
const FEE_TTL = 10_000;

/** Fixed-origin read-only client. Only registry-validated domain IDs reach Iris. */
export function createCctpApi(fetcher: typeof fetch = fetch, now = Date.now) {
  const fees = new Map<string, { expiresAt: number; value: CctpFeeRate[] }>();
  const inflight = new Map<string, Promise<CctpFeeRate[]>>();

  async function loadFees(source: number, destination: number) {
    const key = `${source}/${destination}`;
    const cached = fees.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const task = (async () => {
      const response = await fetcher(`${CIRCLE_API}/v2/burn/USDC/fees/${key}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Circle fee service unavailable (HTTP ${response.status}).`);
      const value = parseCctpFeeRates(await response.json());
      fees.set(key, { expiresAt: now() + FEE_TTL, value });
      return value;
    })();
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    async estimate(body: unknown) {
      const { source, destination } = prepareCctpEstimate(body);
      const inputRecipient = (body as Record<string, unknown>).recipient;
      const recipient = inputRecipient === undefined ? undefined : normalizeCctpRecipient(destination.family, inputRecipient);
      return { ...buildCctpEstimates(body, await loadFees(source.domain, destination.domain), now()), recipient };
    },
  };
}

export const cctpApi = createCctpApi();
