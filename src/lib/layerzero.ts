const VT_API_BASE = "https://transfer.layerzero-api.com/v1";
const OFT_API_BASE = "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts";
const STARGATE_API_BASE = "https://stargate.finance/api/vt";
const STARGATE_V2_API_BASE = "https://stargate.finance/api/v2";
const STARGATE_WEB_API_BASE = "https://stargate.finance/api";
const STARGATE_REFERER = "https://stargate.finance/";

type ProxyOptions = {
  includeApiKey?: boolean;
  baseUrl?: string;
  defaultHeaders?: HeadersInit;
  apiKey?: string | null;
  apiKeyHeader?: string;
};

function getApiKey(apiKeyOverride?: string | null) {
  const apiKey = apiKeyOverride?.trim() || process.env.LAYERZERO_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing LayerZero API key. Add LAYERZERO_API_KEY to the server or provide one in Direct API mode.",
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

export async function fetchLayerZeroOftJson(
  path: string,
  init?: RequestInit,
  options: ProxyOptions = {},
) {
  return fetchBridgeJson(path, init, {
    ...options,
    baseUrl: OFT_API_BASE,
    apiKeyHeader: "x-layerzero-api-key",
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
    defaultHeaders: {
      Referer: STARGATE_REFERER,
      ...options.defaultHeaders,
    },
  });
}

export async function fetchStargateV2ApiJson(
  path: string,
  init?: RequestInit,
  options: Omit<ProxyOptions, "baseUrl"> = {},
) {
  return fetchBridgeJson(path, init, {
    ...options,
    baseUrl: STARGATE_V2_API_BASE,
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
  const headers = new Headers(options.defaultHeaders);

  for (const [key, value] of new Headers(init?.headers).entries()) {
    headers.set(key, value);
  }

  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  if (options.includeApiKey) {
    headers.set(options.apiKeyHeader ?? "x-api-key", getApiKey(options.apiKey));
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
