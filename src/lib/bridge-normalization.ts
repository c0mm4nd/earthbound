import type {
  BridgeQuote,
  BridgeQuoteResponse,
  BuildUserStepsResponse,
} from "@/lib/bridge-types";

export function normalizeBridgeQuoteResponse(data: unknown) {
  if (!data || typeof data !== "object" || !Array.isArray((data as BridgeQuoteResponse).quotes)) {
    return data;
  }

  const response = data as BridgeQuoteResponse;

  return {
    ...response,
    quotes: response.quotes.map(normalizeBridgeQuote),
  } satisfies BridgeQuoteResponse;
}

export function normalizeBuildUserStepsResponse(data: unknown) {
  const response = data && typeof data === "object" ? data : {};

  return {
    ...response,
    userSteps: Array.isArray((response as BuildUserStepsResponse).userSteps)
      ? (response as BuildUserStepsResponse).userSteps
      : [],
  } satisfies BuildUserStepsResponse;
}

function normalizeBridgeQuote(quote: BridgeQuote) {
  return {
    ...quote,
    routeSteps: Array.isArray(quote.routeSteps) ? quote.routeSteps : [],
    userSteps: Array.isArray(quote.userSteps) ? quote.userSteps : [],
  } satisfies BridgeQuote;
}
