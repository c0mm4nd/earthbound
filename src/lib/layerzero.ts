const VT_API_BASE = "https://transfer.layerzero-api.com/v1";
const STARGATE_API_BASE = "https://stargate.finance/api/v2";
const STARGATE_WEB_API_BASE = "https://stargate.finance/api";

type ProxyOptions = {
  includeApiKey?: boolean;
  baseUrl?: string;
};

function getApiKey() {
  const apiKey = process.env.LAYERZERO_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing LAYERZERO_API_KEY. Add it to your environment to enable quotes and execution.",
    );
  }

  return apiKey;
}

export async function fetchLayerZeroJson(
  path: string,
  init?: RequestInit,
  options: ProxyOptions = {},
) {
  return fetchBridgeJson(path, init, {
    ...options,
    baseUrl: VT_API_BASE,
  });
}

export async function fetchStargateApiJson(
  path: string,
  init?: RequestInit,
  options: Omit<ProxyOptions, "baseUrl"> = {},
) {
  return fetchBridgeJson(path, init, {
    ...options,
    baseUrl: STARGATE_API_BASE,
  });
}

export async function fetchStargateWebJson(
  path: string,
  init?: RequestInit,
  options: Omit<ProxyOptions, "baseUrl"> = {},
) {
  return fetchBridgeJson(path, init, {
    ...options,
    baseUrl: STARGATE_WEB_API_BASE,
  });
}

async function fetchBridgeJson(
  path: string,
  init?: RequestInit,
  options: ProxyOptions = {},
) {
  const headers = new Headers(init?.headers);

  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  if (options.includeApiKey) {
    headers.set("x-api-key", getApiKey());
  }

  const response = await fetch(`${options.baseUrl ?? VT_API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  return { response, data };
}
