"use client";

import { useQuery } from "@tanstack/react-query";
import {
  erc20Abi,
  formatUnits,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { sendTransaction, signTypedData, waitForTransactionReceipt } from "wagmi/actions";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BridgeChain,
  BridgeQuote,
  BridgeQuoteResponse,
  BridgeStatusResponse,
  BridgeToken,
  QuoteFee,
  QuoteUserStep,
  SignatureUserStep,
  SignatureTypedDataField,
  TransactionUserStep,
} from "@/lib/bridge-types";
import {
  walletChainByKey,
  wagmiConfig,
  type SupportedChainId,
} from "@/lib/wagmi";

const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "DELIVERED",
  "FAILED",
  "ERROR",
  "CANCELLED",
]);
const FALLBACK_STARGATE_TOKEN_SYMBOL_ALIASES: Record<string, string> = {
  "arbitrum:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e",
  "optimism:0x7f5c764cbc14f9669b88837ca1490cca17c31607": "USDC.e",
  "polygon:0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC.e",
};
const STARGATE_ICONS_BASE_URL = "https://icons-ckg.pages.dev/stargate-light";
const SURFACE_CARD_CLASS =
  "rounded-[1.75rem] border border-white/10 bg-[var(--surface-strong)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:p-5";
const FIELD_CLASS =
  "w-full rounded-[1.25rem] border border-white/10 bg-black px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/28";
const GHOST_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50";

type ExecutionPhase = "idle" | "running" | "success" | "error";

type ExecutionState = {
  phase: ExecutionPhase;
  activeHistoryId?: string;
  txHash?: string;
  transferStatus?: string;
  explorerUrl?: string;
  error?: string;
};

type ExecutionNotification = {
  id: string;
  tone: "neutral" | "success" | "danger";
  title: string;
  message?: string;
  createdAt: number;
  persistent?: boolean;
};

type ExecutionHistoryItem = {
  id: string;
  quoteId: string;
  phase: Exclude<ExecutionPhase, "idle">;
  createdAt: number;
  updatedAt: number;
  routeLabel: string;
  srcChainName: string;
  dstChainName: string;
  srcChainIconUrl?: string;
  dstChainIconUrl?: string;
  srcTokenSymbol: string;
  dstTokenSymbol: string;
  srcTokenIconUrl?: string;
  dstTokenIconUrl?: string;
  srcAmount: string;
  expectedDstAmount: string;
  minimumDstAmount?: string | null;
  destinationAddress: string;
  currentStep?: string;
  transferStatus?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
};

type TokenDisplaySource = "stargate" | "layerzero";

type InlineOptionItem = {
  key: string;
  badgeText: string;
  iconUrl?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  searchTerms?: string[];
  selected?: boolean;
  onSelect: () => void;
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : "Request failed.",
    );
  }

  return data as T;
}

function isNativeToken(address?: string) {
  return address?.toLowerCase() === NATIVE_TOKEN_ADDRESS;
}

function shortenAddress(address?: string) {
  if (!address) {
    return "";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimeLabel(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatTokenAmount(value: string | undefined, decimals: number, digits = 6) {
  if (!value) {
    return "0";
  }

  const formatted = formatUnits(BigInt(value), decimals);
  const [whole, fraction = ""] = formatted.split(".");

  if (!fraction) {
    return whole;
  }

  return `${whole}.${fraction.slice(0, digits)}`.replace(/\.$/, "");
}

function normalizeStargateTokenIconSymbol(symbol?: string) {
  if (!symbol) {
    return null;
  }

  if (symbol === "USDT0.s") {
    return "USDT0";
  }

  return symbol;
}

function getStargateTokenIconUrl(symbol?: string) {
  const normalizedSymbol = normalizeStargateTokenIconSymbol(symbol);

  if (!normalizedSymbol) {
    return undefined;
  }

  return `${STARGATE_ICONS_BASE_URL}/tokens/${normalizedSymbol.toLowerCase()}.svg`;
}

function getStargateChainIconUrl(chainKey?: string) {
  if (!chainKey) {
    return undefined;
  }

  return `${STARGATE_ICONS_BASE_URL}/networks/${chainKey}.svg`;
}

function getBridgeTokenId(token?: Pick<BridgeToken, "address" | "chainKey"> | null) {
  if (!token) {
    return undefined;
  }

  return `${token.chainKey.toLowerCase()}:${token.address.toLowerCase()}`;
}

function getFallbackStargateTokenSymbol(
  token?: Pick<BridgeToken, "address" | "chainKey" | "symbol"> | null,
) {
  const tokenId = getBridgeTokenId(token);

  if (!tokenId) {
    return undefined;
  }

  return FALLBACK_STARGATE_TOKEN_SYMBOL_ALIASES[tokenId] ?? token?.symbol;
}

function getTokenPresentation(
  token: BridgeToken | null | undefined,
  source: TokenDisplaySource,
  stargateTokenDetailsById: ReadonlyMap<string, BridgeToken>,
) {
  if (!token) {
    return null;
  }

  const tokenId = getBridgeTokenId(token);
  const stargateDetails = tokenId ? stargateTokenDetailsById.get(tokenId) : undefined;

  if (source === "stargate") {
    const symbol = stargateDetails?.symbol ?? getFallbackStargateTokenSymbol(token) ?? token.symbol;

    return {
      symbol,
      name: stargateDetails?.name ?? token.name,
      iconUrl: stargateDetails?.icon ?? getStargateTokenIconUrl(symbol),
      priceUsd: stargateDetails?.price?.usd ?? token.price?.usd,
    };
  }

  return {
    symbol: token.symbol,
    name: token.name,
    iconUrl: getStargateTokenIconUrl(token.symbol),
    priceUsd: token.price?.usd,
  };
}

function formatUsd(value: number | string | undefined) {
  if (value === undefined) {
    return null;
  }

  const numeric = typeof value === "string" ? Number(value) : value;

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: numeric >= 100 ? 2 : 4,
  }).format(numeric);
}

function formatEstimatedSeconds(seconds: string | number | undefined | null) {
  const numeric = typeof seconds === "string" ? Number(seconds) : seconds;

  if (!numeric || !Number.isFinite(numeric)) {
    return "Unknown";
  }

  const minutes = Math.round(numeric / 60);

  if (minutes < 1) {
    return "< 1 min";
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function compareQuotes(left: BridgeQuote, right: BridgeQuote) {
  const leftAmount = BigInt(left.dstAmount);
  const rightAmount = BigInt(right.dstAmount);

  if (leftAmount === rightAmount) {
    return Number(left.feeUsd ?? "0") - Number(right.feeUsd ?? "0");
  }

  return rightAmount > leftAmount ? 1 : -1;
}

function getQuoteRouteKey(quote: BridgeQuote) {
  return quote.routeSteps.map((step) => step.type).join("|");
}

function formatRouteType(type: string) {
  const labels: Record<string, string> = {
    STARGATE_V2_TAXI: "Stargate Fast",
    STARGATE_V2_BUS: "Stargate Economy",
    STARGATE_V1: "Stargate V1",
    STARGATE_V2_HYPERCORE: "Stargate HyperCore",
    OFT_V1: "OFT V1",
    OFT_V2: "OFT V2",
    OFT_V2_MULTIHOP: "OFT Multihop",
    OFT_V2_HYPERCORE: "OFT HyperCore",
    AORI_V1: "Aori",
    CCTP_V1: "CCTP V1",
    CCTP_V2: "CCTP V2",
    NATIVE_WRAPPER: "Native Wrapper",
    APTOS_V1: "Aptos",
    HYPERCORE_TO_HYPEREVM: "HyperCore Spot",
    HYPEREVM_TO_HYPERCORE: "HyperEVM Deposit",
    HYPERCORE_V2: "HyperCore",
  };

  return (
    labels[type] ??
    type
      .toLowerCase()
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function formatQuoteRouteLabel(quote: BridgeQuote) {
  if (!quote.routeSteps.length) {
    return "Route unavailable";
  }

  return quote.routeSteps.map((step) => formatRouteType(step.type)).join(" · ");
}

function getQuoteFeeCopy(quote: BridgeQuote) {
  const directFee = formatUsd(quote.feeUsd);

  if (directFee) {
    return directFee;
  }

  return getFeeTotalUsd(quote.fees) ?? "Unknown";
}

function getFeeTotalUsd(fees?: QuoteFee[]) {
  if (!fees?.length) {
    return null;
  }

  const total = fees.reduce((sum, fee) => sum + Number(fee.amountUsd ?? 0), 0);

  return formatUsd(total);
}

function isTransactionStep(step: QuoteUserStep): step is TransactionUserStep {
  return step.type === "TRANSACTION" && "transaction" in step;
}

function isSignatureStep(step: QuoteUserStep): step is SignatureUserStep {
  return step.type === "SIGNATURE" && "signature" in step;
}

function solidityTypeNeedsBigInt(type: string) {
  return /^u?int(\d+)?$/.test(type);
}

function coerceTypedDataValue(
  type: string,
  value: unknown,
  types: Record<string, SignatureTypedDataField[]>,
): unknown {
  if (value == null) {
    return value;
  }

  if (type.endsWith("[]")) {
    const innerType = type.slice(0, -2);
    return Array.isArray(value)
      ? value.map((item) => coerceTypedDataValue(innerType, item, types))
      : value;
  }

  if (types[type]) {
    return coerceTypedDataStruct(types[type], value as Record<string, unknown>, types);
  }

  if (solidityTypeNeedsBigInt(type) && typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }

  return value;
}

function coerceTypedDataStruct(
  fields: SignatureTypedDataField[],
  value: Record<string, unknown>,
  types: Record<string, SignatureTypedDataField[]>,
) {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field.name] = coerceTypedDataValue(field.type, value[field.name], types);
  }

  return result;
}

async function pollTransferStatus(
  quoteId: string,
  txHash?: string,
  onUpdate?: (status: BridgeStatusResponse) => void,
) {
  let latest: BridgeStatusResponse | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const query = txHash ? `?txHash=${txHash}` : "";
    const status = await fetchJson<BridgeStatusResponse>(
      `/api/bridge/status/${quoteId}${query}`,
    );
    latest = status;
    onUpdate?.(status);

    if (TRANSFER_TERMINAL_STATUSES.has(status.status)) {
      return status;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 4_000));
  }

  return latest;
}

function getExecutionTone(phase: ExecutionPhase) {
  if (phase === "success") {
    return "success" as const;
  }

  if (phase === "error") {
    return "danger" as const;
  }

  return "neutral" as const;
}

function getExecutionPhaseLabel(phase: ExecutionPhase) {
  if (phase === "running") {
    return "Running";
  }

  if (phase === "success") {
    return "Success";
  }

  if (phase === "error") {
    return "Error";
  }

  return "Idle";
}

function getExecutionHistoryStatus(item: ExecutionHistoryItem) {
  return item.transferStatus ?? getExecutionPhaseLabel(item.phase);
}

function StatusPill({
  tone,
  children,
}: {
  tone: "neutral" | "success" | "danger";
  children: React.ReactNode;
}) {
  const toneClasses =
    tone === "success"
      ? "border-white bg-white text-black"
      : tone === "danger"
        ? "border-white/30 bg-white/[0.03] text-white"
        : "border-white/12 bg-white/[0.04] text-white/76";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] ${toneClasses}`}
    >
      {children}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
        {eyebrow}
      </p>
      <h2 className="text-lg font-medium tracking-[-0.03em] text-white">{title}</h2>
      {description ? (
        <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">{description}</p>
      ) : null}
    </div>
  );
}

function AssetIcon({
  label,
  src,
  size = "md",
}: {
  label: string;
  src?: string;
  size?: "xs" | "sm" | "md";
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const content = label.replace(/[^a-z0-9]/gi, "").slice(0, size === "md" ? 3 : 2) || "?";
  const sizeClass =
    size === "xs"
      ? "h-4 w-4 text-[7px]"
      : size === "sm"
        ? "h-9 w-9 text-[9px]"
        : "h-11 w-11 text-[11px]";

  if (!src || hasImageError) {
    return (
      <span
        className={`inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.06] font-semibold uppercase tracking-[0.18em] text-white`}
        aria-hidden="true"
      >
        {content}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex ${sizeClass} shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white/[0.06]`}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        onError={() => setHasImageError(true)}
      />
    </span>
  );
}

function InlineAssetLabel({
  label,
  src,
  children,
  size = "xs",
  className = "",
}: {
  label: string;
  src?: string;
  children: ReactNode;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`.trim()}>
      <AssetIcon label={label} src={src} size={size} />
      {children}
    </span>
  );
}

function InlineOptionList({
  title,
  items,
  emptyState,
  loadingLabel,
}: {
  title: string;
  items: InlineOptionItem[];
  emptyState: string;
  loadingLabel?: string | null;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => {
      const haystack = [
        item.title,
        item.subtitle,
        item.meta,
        item.badgeText,
        ...(item.searchTerms ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [items, normalizedQuery]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
          {title}
        </p>
        {items.length ? (
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
            {items.length}
          </p>
        ) : null}
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${title.toLowerCase()}`}
        className={`${FIELD_CLASS} h-10 px-3 py-2 text-xs`}
      />

      {loadingLabel ? (
        <div className="flex min-h-0 flex-1 items-center rounded-[1.25rem] border border-white/10 bg-black px-4 py-3 text-sm text-[var(--muted)]">
          {loadingLabel}
        </div>
      ) : filteredItems.length ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {filteredItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onSelect}
              className={`flex w-full items-center gap-2.5 rounded-[1.2rem] border px-3 py-2.5 text-left transition ${
                item.selected
                  ? "border-white bg-white text-black"
                  : "border-white/10 bg-black text-white hover:border-white/24 hover:bg-white/[0.04]"
              }`}
            >
              <AssetIcon label={item.badgeText} src={item.iconUrl} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                {item.subtitle ? (
                  <span
                    className={`mt-0.5 block truncate text-xs ${
                      item.selected ? "text-black/66" : "text-[var(--muted)]"
                    }`}
                  >
                    {item.subtitle}
                  </span>
                ) : null}
                {item.meta ? (
                  <span
                    className={`mt-1 block text-[10px] font-semibold uppercase tracking-[0.18em] ${
                      item.selected ? "text-black/72" : "text-[var(--muted)]"
                    }`}
                  >
                    {item.meta}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
          {normalizedQuery ? `No matching ${title.toLowerCase()}.` : emptyState}
        </div>
      )}
    </div>
  );
}

export function BridgeApp() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending: isConnectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitchPending } = useSwitchChain();
  const [srcChainKey, setSrcChainKey] = useState("");
  const [dstChainKey, setDstChainKey] = useState("");
  const [srcTokenAddress, setSrcTokenAddress] = useState("");
  const [dstTokenAddress, setDstTokenAddress] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [quotes, setQuotes] = useState<BridgeQuote[]>([]);
  const [selectedQuoteRouteKey, setSelectedQuoteRouteKey] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [lastQuoteUpdatedAt, setLastQuoteUpdatedAt] = useState<number | null>(null);
  const [executionState, setExecutionState] = useState<ExecutionState>({
    phase: "idle",
  });
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);
  const [executionNotifications, setExecutionNotifications] = useState<
    ExecutionNotification[]
  >([]);
  const [refreshCountdownNow, setRefreshCountdownNow] = useState(() => Date.now());
  const [tokenDisplaySource, setTokenDisplaySource] = useState<TokenDisplaySource>("stargate");
  const balanceSwitchAttemptRef = useRef<string | null>(null);
  const notificationTimeoutsRef = useRef(new Map<string, number>());
  const quoteRequestIdRef = useRef(0);
  const isQuotingRef = useRef(false);
  const requestQuoteRef = useRef<
    (mode?: "auto" | "manual" | "refresh") => Promise<void>
  >(async () => undefined);

  const injectedConnector =
    connectors.find((connector) => connector.type === "injected") ?? connectors[0];

  const chainsQuery = useQuery({
    queryKey: ["bridge", "chains"],
    queryFn: () => fetchJson<{ chains: BridgeChain[] }>("/api/bridge/chains"),
    staleTime: 60 * 60 * 1000,
  });

  const tokensQuery = useQuery({
    queryKey: ["bridge", "tokens", "catalog"],
    queryFn: () => fetchJson<{ tokens: BridgeToken[] }>("/api/bridge/tokens"),
    staleTime: 60 * 60 * 1000,
  });

  const stargateTokenDetailsQuery = useQuery({
    queryKey: ["bridge", "tokens", "display", "stargate"],
    queryFn: () => fetchJson<{ tokens: BridgeToken[] }>("/api/bridge/token-details"),
    staleTime: 60 * 60 * 1000,
  });

  const stargateTokenDetailsById = useMemo(() => {
    const nextTokenDetailsById = new Map<string, BridgeToken>();

    for (const token of stargateTokenDetailsQuery.data?.tokens ?? []) {
      const tokenId = getBridgeTokenId(token);

      if (tokenId) {
        nextTokenDetailsById.set(tokenId, token);
      }
    }

    return nextTokenDetailsById;
  }, [stargateTokenDetailsQuery.data]);

  const supportedChains = useMemo(() => {
    return (chainsQuery.data?.chains ?? []).filter(
      (chain) =>
        chain.chainType === "EVM" &&
        chain.chainKey in walletChainByKey &&
        chain.chainKey !== "stable",
    );
  }, [chainsQuery.data]);

  const srcChain = useMemo(
    () => supportedChains.find((chain) => chain.chainKey === srcChainKey) ?? null,
    [srcChainKey, supportedChains],
  );

  const dstChain = useMemo(
    () => supportedChains.find((chain) => chain.chainKey === dstChainKey) ?? null,
    [dstChainKey, supportedChains],
  );

  const srcTokens = useMemo(() => {
    return (tokensQuery.data?.tokens ?? [])
      .filter((token) => token.chainKey === srcChainKey)
      .sort((left, right) => {
        const leftScore = Number(left.price?.usd ?? 0);
        const rightScore = Number(right.price?.usd ?? 0);

        if (leftScore === rightScore) {
          return left.symbol.localeCompare(right.symbol);
        }

        return rightScore - leftScore;
      });
  }, [srcChainKey, tokensQuery.data]);

  const routeTokensQuery = useQuery({
    queryKey: ["bridge", "tokens", "routes", srcChainKey, srcTokenAddress],
    enabled: Boolean(srcChainKey && srcTokenAddress),
    queryFn: () =>
      fetchJson<{ tokens: BridgeToken[] }>(
        `/api/bridge/tokens?transferrableFromChainKey=${encodeURIComponent(srcChainKey)}&transferrableFromTokenAddress=${encodeURIComponent(srcTokenAddress)}`,
      ),
    staleTime: 5 * 60 * 1000,
  });

  const selectableDestinationChains = useMemo(() => {
    if (!routeTokensQuery.data?.tokens?.length) {
      return supportedChains.filter((chain) => chain.chainKey !== srcChainKey);
    }

    const availableKeys = new Set(
      routeTokensQuery.data.tokens.map((token) => token.chainKey),
    );

    return supportedChains.filter(
      (chain) => chain.chainKey !== srcChainKey && availableKeys.has(chain.chainKey),
    );
  }, [routeTokensQuery.data, srcChainKey, supportedChains]);

  const destinationTokens = useMemo(() => {
    return (routeTokensQuery.data?.tokens ?? [])
      .filter((token) => token.chainKey === dstChainKey)
      .sort((left, right) => {
        const leftScore = Number(left.price?.usd ?? 0);
        const rightScore = Number(right.price?.usd ?? 0);

        if (leftScore === rightScore) {
          return left.symbol.localeCompare(right.symbol);
        }

        return rightScore - leftScore;
      });
  }, [dstChainKey, routeTokensQuery.data]);

  const selectedSrcToken = useMemo(
    () =>
      srcTokens.find(
        (token) => token.address.toLowerCase() === srcTokenAddress.toLowerCase(),
      ) ?? null,
    [srcTokenAddress, srcTokens],
  );

  const selectedDstToken = useMemo(
    () =>
      destinationTokens.find(
        (token) => token.address.toLowerCase() === dstTokenAddress.toLowerCase(),
      ) ?? null,
    [destinationTokens, dstTokenAddress],
  );
  const selectedSrcTokenPresentation = useMemo(
    () => getTokenPresentation(selectedSrcToken, tokenDisplaySource, stargateTokenDetailsById),
    [selectedSrcToken, stargateTokenDetailsById, tokenDisplaySource],
  );
  const selectedDstTokenPresentation = useMemo(
    () => getTokenPresentation(selectedDstToken, tokenDisplaySource, stargateTokenDetailsById),
    [selectedDstToken, stargateTokenDetailsById, tokenDisplaySource],
  );
  const selectedSrcTokenSymbol = selectedSrcTokenPresentation?.symbol ?? "--";
  const selectedDstTokenSymbol = selectedDstTokenPresentation?.symbol ?? "--";
  const selectedSrcTokenIconUrl =
    selectedSrcTokenPresentation?.iconUrl ?? getStargateTokenIconUrl(selectedSrcTokenSymbol);
  const selectedDstTokenIconUrl =
    selectedDstTokenPresentation?.iconUrl ?? getStargateTokenIconUrl(selectedDstTokenSymbol);

  const srcChainItems = useMemo<InlineOptionItem[]>(
    () =>
      supportedChains.map((chain) => ({
        key: chain.chainKey,
        badgeText: chain.shortName,
        iconUrl: getStargateChainIconUrl(chain.chainKey),
        title: chain.name,
        subtitle: `${chain.shortName} · ${chain.nativeCurrency.symbol}`,
        searchTerms: [chain.chainKey, chain.name, chain.shortName, chain.nativeCurrency.symbol],
        selected: chain.chainKey === srcChainKey,
        onSelect: () => setSrcChainKey(chain.chainKey),
      })),
    [srcChainKey, supportedChains],
  );

  const srcTokenItems = useMemo<InlineOptionItem[]>(
    () =>
      srcTokens.map((token) => {
        const presentation = getTokenPresentation(
          token,
          tokenDisplaySource,
          stargateTokenDetailsById,
        );
        const displaySymbol = presentation?.symbol ?? token.symbol;

        return {
          key: `${token.chainKey}:${token.address}`,
          badgeText: displaySymbol,
          iconUrl: presentation?.iconUrl,
          title: displaySymbol,
          subtitle: presentation?.name ?? token.name,
          meta:
            presentation?.priceUsd !== undefined
              ? formatUsd(presentation.priceUsd) ?? undefined
              : undefined,
          searchTerms: [displaySymbol, token.symbol, token.name, token.address, token.chainKey],
          selected: token.address.toLowerCase() === srcTokenAddress.toLowerCase(),
          onSelect: () => setSrcTokenAddress(token.address),
        };
      }),
    [srcTokenAddress, srcTokens, stargateTokenDetailsById, tokenDisplaySource],
  );

  const dstChainItems = useMemo<InlineOptionItem[]>(
    () =>
      selectableDestinationChains.map((chain) => ({
        key: chain.chainKey,
        badgeText: chain.shortName,
        iconUrl: getStargateChainIconUrl(chain.chainKey),
        title: chain.name,
        subtitle: `${chain.shortName} · ${chain.nativeCurrency.symbol}`,
        searchTerms: [chain.chainKey, chain.name, chain.shortName, chain.nativeCurrency.symbol],
        selected: chain.chainKey === dstChainKey,
        onSelect: () => setDstChainKey(chain.chainKey),
      })),
    [dstChainKey, selectableDestinationChains],
  );

  const dstTokenItems = useMemo<InlineOptionItem[]>(
    () =>
      destinationTokens.map((token) => {
        const presentation = getTokenPresentation(
          token,
          tokenDisplaySource,
          stargateTokenDetailsById,
        );
        const displaySymbol = presentation?.symbol ?? token.symbol;

        return {
          key: `${token.chainKey}:${token.address}`,
          badgeText: displaySymbol,
          iconUrl: presentation?.iconUrl,
          title: displaySymbol,
          subtitle: presentation?.name ?? token.name,
          meta:
            presentation?.priceUsd !== undefined
              ? formatUsd(presentation.priceUsd) ?? undefined
              : undefined,
          searchTerms: [displaySymbol, token.symbol, token.name, token.address, token.chainKey],
          selected: token.address.toLowerCase() === dstTokenAddress.toLowerCase(),
          onSelect: () => setDstTokenAddress(token.address),
        };
      }),
    [destinationTokens, dstTokenAddress, stargateTokenDetailsById, tokenDisplaySource],
  );

  const quoteRequestState = useMemo(() => {
    if (!address) {
      return {
        ready: false,
        reason: "Connect a wallet before requesting a quote.",
      } as const;
    }

    if (!srcChain || !dstChain || srcChain.chainKey === dstChain.chainKey) {
      return {
        ready: false,
        reason: "Choose two different EVM chains.",
      } as const;
    }

    if (!selectedSrcToken || !selectedDstToken) {
      return {
        ready: false,
        reason: "Select both source and destination tokens.",
      } as const;
    }

    if (!destinationAddress || !isAddress(destinationAddress)) {
      return {
        ready: false,
        reason: "Enter a valid EVM destination address.",
      } as const;
    }

    try {
      const parsedAmount = parseUnits(amountInput || "0", selectedSrcToken.decimals);

      if (parsedAmount <= BigInt(0)) {
        return {
          ready: false,
          reason: "Amount must be greater than zero.",
        } as const;
      }

      return {
        ready: true,
        reason: null,
        payload: {
          srcChainKey: srcChain.chainKey,
          dstChainKey: dstChain.chainKey,
          srcTokenAddress: selectedSrcToken.address,
          dstTokenAddress: selectedDstToken.address,
          srcWalletAddress: address,
          dstWalletAddress: destinationAddress,
          amount: parsedAmount.toString(),
        },
      } as const;
    } catch {
      return {
        ready: false,
        reason: "Enter a valid amount.",
      } as const;
    }
  }, [
    address,
    amountInput,
    destinationAddress,
    dstChain,
    selectedDstToken,
    selectedSrcToken,
    srcChain,
  ]);

  const quoteRequestKey = quoteRequestState.ready
    ? JSON.stringify(quoteRequestState.payload)
    : "";

  const quote = useMemo(() => {
    if (!quotes.length) {
      return null;
    }

    if (!selectedQuoteRouteKey) {
      return quotes[0];
    }

    return (
      quotes.find((candidate) => getQuoteRouteKey(candidate) === selectedQuoteRouteKey) ??
      quotes[0]
    );
  }, [quotes, selectedQuoteRouteKey]);

  const availableQuoteCount = quotes.length;
  const bestQuoteRouteKey = quotes[0] ? getQuoteRouteKey(quotes[0]) : null;

  const balanceEnabled = Boolean(
    address &&
      srcChain &&
      selectedSrcToken &&
      chainId === srcChain.chainId &&
      isConnected,
  );
  const supportedSrcChainId = srcChain?.chainId as SupportedChainId | undefined;

  const nativeBalanceQuery = useBalance({
    address: address as Address | undefined,
    chainId: supportedSrcChainId,
    query: {
      enabled: balanceEnabled && Boolean(selectedSrcToken && isNativeToken(selectedSrcToken.address)),
      staleTime: 15 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const erc20BalanceQuery = useReadContract({
    address:
      selectedSrcToken && !isNativeToken(selectedSrcToken.address)
        ? (selectedSrcToken.address as Address)
        : undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address as Address] : undefined,
    chainId: supportedSrcChainId,
    query: {
      enabled: balanceEnabled && Boolean(selectedSrcToken && !isNativeToken(selectedSrcToken.address)),
      staleTime: 15 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const selectedBalanceValue =
    selectedSrcToken && isNativeToken(selectedSrcToken.address)
      ? nativeBalanceQuery.data?.value
      : erc20BalanceQuery.data;

  const isBalanceLoading =
    selectedSrcToken && isNativeToken(selectedSrcToken.address)
      ? nativeBalanceQuery.isPending
      : erc20BalanceQuery.isPending;

  const balanceCopy = useMemo(() => {
    if (!selectedSrcToken) {
      return "Select a token";
    }

    if (!address) {
      return "Connect wallet";
    }

    if (srcChain && chainId !== srcChain.chainId) {
      return isSwitchPending ? "Switching..." : "Auto switching...";
    }

    if (isBalanceLoading) {
      return "Loading...";
    }

    if (selectedBalanceValue !== undefined) {
      return `${Number(
        formatUnits(selectedBalanceValue, selectedSrcToken.decimals),
      ).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      })} ${selectedSrcTokenSymbol}`;
    }

    return "Unavailable";
  }, [
    address,
    chainId,
    isBalanceLoading,
    isSwitchPending,
    selectedBalanceValue,
    selectedSrcToken,
    selectedSrcTokenSymbol,
    srcChain,
  ]);

  function dismissExecutionNotification(notificationId: string) {
    const timeoutId = notificationTimeoutsRef.current.get(notificationId);

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      notificationTimeoutsRef.current.delete(notificationId);
    }

    setExecutionNotifications((current) =>
      current.filter((notification) => notification.id !== notificationId),
    );
  }

  function pushExecutionNotification({
    tone,
    title,
    message,
    persistent = false,
  }: Omit<ExecutionNotification, "id" | "createdAt">) {
    const notificationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const nextNotification: ExecutionNotification = {
      id: notificationId,
      tone,
      title,
      message,
      createdAt: Date.now(),
      persistent,
    };

    setExecutionNotifications((current) => [...current, nextNotification].slice(-4));

    if (!persistent) {
      const timeoutId = window.setTimeout(() => {
        setExecutionNotifications((current) =>
          current.filter((notification) => notification.id !== notificationId),
        );
        notificationTimeoutsRef.current.delete(notificationId);
      }, tone === "success" ? 6_000 : 4_500);

      notificationTimeoutsRef.current.set(notificationId, timeoutId);
    }

    return notificationId;
  }

  function prependExecutionHistoryItem(item: ExecutionHistoryItem) {
    setExecutionHistory((current) => [item, ...current].slice(0, 12));
  }

  function updateExecutionHistoryItem(
    historyId: string,
    patch: Partial<Omit<ExecutionHistoryItem, "id" | "quoteId" | "createdAt">>,
  ) {
    setExecutionHistory((current) =>
      current.map((item) =>
        item.id === historyId
          ? {
              ...item,
              ...patch,
              updatedAt: Date.now(),
            }
          : item,
      ),
    );
  }

  useEffect(() => {
    const notificationTimeouts = notificationTimeoutsRef.current;

    return () => {
      for (const timeoutId of notificationTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }

      notificationTimeouts.clear();
    };
  }, []);

  useEffect(() => {
    if (!supportedChains.length) {
      return;
    }

    setSrcChainKey((current) => {
      if (current && supportedChains.some((chain) => chain.chainKey === current)) {
        return current;
      }

      return (
        supportedChains.find((chain) => chain.chainKey === "ethereum")?.chainKey ??
        supportedChains[0].chainKey
      );
    });
  }, [supportedChains]);

  useEffect(() => {
    if (!supportedChains.length) {
      return;
    }

    setDstChainKey((current) => {
      if (
        current &&
        current !== srcChainKey &&
        supportedChains.some((chain) => chain.chainKey === current)
      ) {
        return current;
      }

      return (
        supportedChains.find(
          (chain) => chain.chainKey === "arbitrum" && chain.chainKey !== srcChainKey,
        )?.chainKey ??
        supportedChains.find((chain) => chain.chainKey !== srcChainKey)?.chainKey ??
        ""
      );
    });
  }, [srcChainKey, supportedChains]);

  useEffect(() => {
    setDestinationAddress((current) => {
      if (!address) {
        return "";
      }

      return current || address;
    });
  }, [address]);

  useEffect(() => {
    isQuotingRef.current = isQuoting;
  }, [isQuoting]);

  useEffect(() => {
    if (
      !address ||
      !isConnected ||
      !srcChain ||
      !selectedSrcToken ||
      !chainId
    ) {
      balanceSwitchAttemptRef.current = null;
      return;
    }

    if (chainId === srcChain.chainId) {
      balanceSwitchAttemptRef.current = null;
      return;
    }

    if (executionState.phase === "running") {
      return;
    }

    if (isSwitchPending) {
      return;
    }

    const attemptKey = `${address}:${chainId}->${srcChain.chainId}`;

    if (balanceSwitchAttemptRef.current === attemptKey) {
      return;
    }

    balanceSwitchAttemptRef.current = attemptKey;
    void switchChainAsync({ chainId: srcChain.chainId as SupportedChainId }).catch(() => undefined);
  }, [
    address,
    chainId,
    executionState.phase,
    isConnected,
    isSwitchPending,
    selectedSrcToken,
    srcChain,
    switchChainAsync,
  ]);

  useEffect(() => {
    if (!selectableDestinationChains.length) {
      return;
    }

    setDstChainKey((current) => {
      if (current && selectableDestinationChains.some((chain) => chain.chainKey === current)) {
        return current;
      }

      return selectableDestinationChains[0].chainKey;
    });
  }, [selectableDestinationChains]);

  useEffect(() => {
    setSrcTokenAddress("");
    setDstTokenAddress("");
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setExecutionState({ phase: "idle" });
  }, [srcChainKey]);

  useEffect(() => {
    setDstTokenAddress("");
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setExecutionState({ phase: "idle" });
  }, [srcTokenAddress]);

  useEffect(() => {
    if (
      dstTokenAddress &&
      !destinationTokens.some(
        (token) => token.address.toLowerCase() === dstTokenAddress.toLowerCase(),
      )
    ) {
      setDstTokenAddress("");
    }
  }, [destinationTokens, dstTokenAddress]);

  useEffect(() => {
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setExecutionState({ phase: "idle" });
  }, [amountInput, destinationAddress, dstChainKey, dstTokenAddress]);

  async function handleRequestQuote(mode: "auto" | "manual" | "refresh" = "manual") {
    if (!quoteRequestState.ready) {
      if (mode === "manual") {
        setQuoteError(quoteRequestState.reason);
      }

      return;
    }

    if (isQuotingRef.current) {
      return;
    }

    const requestId = quoteRequestIdRef.current + 1;
    quoteRequestIdRef.current = requestId;
    isQuotingRef.current = true;
    setIsQuoting(true);
    setQuoteError(null);

    try {
      const quoteResponse = await fetchJson<BridgeQuoteResponse>("/api/bridge/quotes", {
        method: "POST",
        body: JSON.stringify(quoteRequestState.payload),
      });

      if (!quoteResponse.quotes.length) {
        throw new Error(
          quoteResponse.rejectedQuotes?.[0]?.error ?? "No route available for this pair.",
        );
      }

      const nextQuotes = [...quoteResponse.quotes].sort(compareQuotes);

      if (requestId !== quoteRequestIdRef.current) {
        return;
      }

      setQuotes(nextQuotes);
      setSelectedQuoteRouteKey((current) => {
        if (current && nextQuotes.some((candidate) => getQuoteRouteKey(candidate) === current)) {
          return current;
        }

        return getQuoteRouteKey(nextQuotes[0]);
      });
      setLastQuoteUpdatedAt(Date.now());
    } catch (error) {
      if (requestId !== quoteRequestIdRef.current) {
        return;
      }

      setQuoteError(getErrorMessage(error));
    } finally {
      if (requestId === quoteRequestIdRef.current) {
        isQuotingRef.current = false;
        setIsQuoting(false);
      }
    }
  }

  useEffect(() => {
    requestQuoteRef.current = handleRequestQuote;
  });

  useEffect(() => {
    if (!quoteRequestState.ready || executionState.phase === "running") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestQuoteRef.current("auto");
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [executionState.phase, quoteRequestKey, quoteRequestState.ready]);

  useEffect(() => {
    if (!quoteRequestState.ready || executionState.phase === "running") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestQuoteRef.current("refresh");
    }, lastQuoteUpdatedAt ? Math.max(0, lastQuoteUpdatedAt + 10_000 - Date.now()) : 10_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [executionState.phase, lastQuoteUpdatedAt, quoteRequestKey, quoteRequestState.ready]);

  useEffect(() => {
    if (!quoteRequestState.ready || executionState.phase === "running" || !lastQuoteUpdatedAt) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRefreshCountdownNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [executionState.phase, lastQuoteUpdatedAt, quoteRequestKey, quoteRequestState.ready]);

  async function handleExecuteQuote() {
    if (!quote || !address || !srcChain || !dstChain || !selectedSrcToken || !selectedDstToken) {
      return;
    }

    const historyId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const initialHistoryItem: ExecutionHistoryItem = {
      id: historyId,
      quoteId: quote.id,
      phase: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      routeLabel: formatQuoteRouteLabel(quote),
      srcChainName: srcChain.shortName,
      dstChainName: dstChain.shortName,
      srcChainIconUrl: getStargateChainIconUrl(srcChain.chainKey),
      dstChainIconUrl: getStargateChainIconUrl(dstChain.chainKey),
      srcTokenSymbol: selectedSrcTokenSymbol,
      dstTokenSymbol: selectedDstTokenSymbol,
      srcTokenIconUrl: selectedSrcTokenIconUrl,
      dstTokenIconUrl: selectedDstTokenIconUrl,
      srcAmount: `${formatTokenAmount(quote.srcAmount, selectedSrcToken.decimals)} ${selectedSrcTokenSymbol}`,
      expectedDstAmount: `${formatTokenAmount(quote.dstAmount, selectedDstToken.decimals)} ${selectedDstTokenSymbol}`,
      minimumDstAmount:
        quote.dstAmountMin && selectedDstToken
          ? `${formatTokenAmount(quote.dstAmountMin, selectedDstToken.decimals)} ${selectedDstTokenSymbol}`
          : null,
      destinationAddress,
      currentStep: "Preparing execution",
    };

    prependExecutionHistoryItem(initialHistoryItem);
    setExecutionState({
      phase: "running",
      activeHistoryId: historyId,
    });
    pushExecutionNotification({
      tone: "neutral",
      title: "Execution started",
      message: `${initialHistoryItem.srcChainName} to ${initialHistoryItem.dstChainName} · ${initialHistoryItem.srcAmount}`,
    });

    try {
      if (chainId !== srcChain.chainId) {
        updateExecutionHistoryItem(historyId, {
          currentStep: `Switching wallet to ${srcChain.shortName}`,
        });
        pushExecutionNotification({
          tone: "neutral",
          title: "Switch network",
          message: `Move wallet to ${srcChain.shortName} to continue.`,
        });
        await switchChainAsync({ chainId: srcChain.chainId as SupportedChainId });
      }

      let lastTxHash: Hex | undefined;
      let latestTransferStatus = "";

      for (const [index, step] of quote.userSteps.entries()) {
        if (isTransactionStep(step)) {
          const payload = step.transaction?.encoded;

          if (!payload?.to) {
            throw new Error(`Step ${index + 1} is missing transaction payload.`);
          }

          updateExecutionHistoryItem(historyId, {
            currentStep: step.description ?? `Sending transaction step ${index + 1}`,
          });

          const hash = await sendTransaction(wagmiConfig, {
            account: address as Address,
            chainId: srcChain.chainId as SupportedChainId,
            to: payload.to as Address,
            data: payload.data,
            value: payload.value ? BigInt(payload.value) : BigInt(0),
            gas: payload.gasLimit ? BigInt(payload.gasLimit) : undefined,
          });

          lastTxHash = hash;
          setExecutionState((current) => ({
            ...current,
            txHash: hash,
          }));
          updateExecutionHistoryItem(historyId, {
            txHash: hash,
            currentStep: "Transaction submitted",
          });
          pushExecutionNotification({
            tone: "neutral",
            title: "Transaction submitted",
            message: hash,
          });

          await waitForTransactionReceipt(wagmiConfig, {
            chainId: srcChain.chainId as SupportedChainId,
            hash,
          });

          updateExecutionHistoryItem(historyId, {
            currentStep: "Transaction confirmed",
          });
          pushExecutionNotification({
            tone: "neutral",
            title: "Transaction confirmed",
            message: shortenAddress(hash),
          });
          continue;
        }

        if (isSignatureStep(step)) {
          const typedData = step.signature?.typedData;

          if (!typedData?.primaryType) {
            throw new Error(`Step ${index + 1} is missing typed data.`);
          }

          updateExecutionHistoryItem(historyId, {
            currentStep: step.description ?? `Signing step ${index + 1}`,
          });

          const signature = await (signTypedData as (...args: unknown[]) => Promise<Hex>)(
            wagmiConfig,
            {
              account: address as Address,
              domain: coerceTypedDataStruct(
                typedData.types.EIP712Domain ?? [],
                typedData.domain ?? {},
                typedData.types,
              ),
              message: coerceTypedDataStruct(
                typedData.types[typedData.primaryType] ?? [],
                typedData.message ?? {},
                typedData.types,
              ),
              primaryType: typedData.primaryType,
              types: typedData.types,
            },
          );

          updateExecutionHistoryItem(historyId, {
            currentStep: `Signature collected for step ${index + 1}`,
          });

          await fetchJson("/api/bridge/submit-signature", {
            method: "POST",
            body: JSON.stringify({
              quoteId: quote.id,
              signatures: [signature],
            }),
          });

          updateExecutionHistoryItem(historyId, {
            currentStep: `Signature submitted for step ${index + 1}`,
          });
          pushExecutionNotification({
            tone: "neutral",
            title: "Signature submitted",
            message: `Step ${index + 1}`,
          });
          continue;
        }
        throw new Error(`Unsupported user step type: ${step.type}`);
      }

      updateExecutionHistoryItem(historyId, {
        currentStep: "Waiting for transfer settlement",
      });
      const transferStatus = await pollTransferStatus(quote.id, lastTxHash, (status) => {
        const statusError = status.error ?? status.substatus;
        const isTerminal = TRANSFER_TERMINAL_STATUSES.has(status.status);

        updateExecutionHistoryItem(historyId, {
          transferStatus: status.status,
          explorerUrl: status.explorerUrl,
          error: statusError,
          currentStep: isTerminal ? undefined : `Tracking transfer · ${status.status}`,
        });

        setExecutionState((current) =>
          current.activeHistoryId === historyId
            ? {
                ...current,
                transferStatus: status.status,
                explorerUrl: status.explorerUrl,
                error: statusError,
              }
            : current,
        );

        if (status.status !== latestTransferStatus) {
          latestTransferStatus = status.status;

          if (!isTerminal) {
            pushExecutionNotification({
              tone: "neutral",
              title: "Transfer update",
              message: status.status,
            });
          }
        }
      });

      if (!transferStatus) {
        throw new Error("Transfer status timed out before a terminal update.");
      }

      const succeeded =
        transferStatus.status === "COMPLETED" || transferStatus.status === "DELIVERED";
      const transferError = transferStatus.error ?? transferStatus.substatus;

      setExecutionState({
        phase: succeeded ? "success" : "error",
        activeHistoryId: historyId,
        txHash: lastTxHash,
        transferStatus: transferStatus.status,
        explorerUrl: transferStatus.explorerUrl,
        error: succeeded ? undefined : transferError,
      });
      updateExecutionHistoryItem(historyId, {
        phase: succeeded ? "success" : "error",
        transferStatus: transferStatus.status,
        explorerUrl: transferStatus.explorerUrl,
        error: succeeded ? undefined : transferError,
        currentStep: undefined,
      });
      pushExecutionNotification({
        tone: succeeded ? "success" : "danger",
        title: succeeded ? "Transfer completed" : "Transfer failed",
        message: succeeded
          ? `${initialHistoryItem.srcAmount} -> ${initialHistoryItem.expectedDstAmount}`
          : transferError ?? transferStatus.status,
        persistent: !succeeded,
      });

      if (selectedSrcToken && isNativeToken(selectedSrcToken.address)) {
        void nativeBalanceQuery.refetch();
      } else {
        void erc20BalanceQuery.refetch();
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      setExecutionState((current) => ({
        ...current,
        phase: "error",
        activeHistoryId: historyId,
        error: errorMessage,
      }));
      updateExecutionHistoryItem(historyId, {
        phase: "error",
        error: errorMessage,
        currentStep: undefined,
      });
      pushExecutionNotification({
        tone: "danger",
        title: "Execution failed",
        message: errorMessage,
        persistent: true,
      });
    }
  }

  const canRequestQuote = quoteRequestState.ready;
  const canFillMax = Boolean(selectedSrcToken && selectedBalanceValue !== undefined);
  const quoteReady = Boolean(quote && selectedSrcToken && selectedDstToken);
  const destinationPreviewAmount =
    quote && selectedDstToken
      ? formatTokenAmount(quote.dstAmount, selectedDstToken.decimals)
      : "0.00";
  const minimumReceiveCopy =
    quote && selectedDstToken && quote.dstAmountMin
      ? `${formatTokenAmount(quote.dstAmountMin, selectedDstToken.decimals)} ${selectedDstTokenSymbol}`
      : null;
  const refreshCountdownSeconds =
    canRequestQuote && lastQuoteUpdatedAt
      ? Math.max(0, Math.ceil((lastQuoteUpdatedAt + 10_000 - refreshCountdownNow) / 1_000))
      : null;
  const canExecuteQuote = Boolean(quote) && executionState.phase !== "running";
  const refreshButtonCopy = isQuoting
    ? quote
      ? "Refreshing..."
      : "Requesting quote..."
    : canRequestQuote
      ? refreshCountdownSeconds !== null
        ? `Refresh · ${refreshCountdownSeconds}s`
        : "Refresh"
      : "Refresh";
  const executionTone = getExecutionTone(executionState.phase);
  const executionPhaseCopy = getExecutionPhaseLabel(executionState.phase);
  const activeExecutionHistoryItem = executionState.activeHistoryId
    ? executionHistory.find((item) => item.id === executionState.activeHistoryId) ?? null
    : null;
  const tokenDisplaySourceButtonCopy =
    tokenDisplaySource === "stargate" ? "Tokens · Stargate" : "Tokens · LayerZero";
  function handleFillMax() {
    if (!selectedSrcToken || selectedBalanceValue === undefined) {
      return;
    }

    setAmountInput(formatUnits(selectedBalanceValue, selectedSrcToken.decimals));
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--background)] text-[var(--foreground)] xl:h-screen">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent,rgba(255,255,255,0.025)_40%,transparent)]" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-3 p-3 sm:p-4 xl:h-full">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-[1.25rem] border border-white/10 bg-white/[0.03] px-3 py-2.5 backdrop-blur">
          <div className="min-w-0 space-y-1 text-right">
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">
              <span className="inline-flex shrink-0 items-center rounded-full border border-white/12 bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-white">
                Earthbound
              </span>
              <p className="truncate text-sm font-medium tracking-[-0.03em] text-white">
                faster Stargate bridging frontend
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-[11px] text-[var(--muted)]">
              <span className="uppercase tracking-[0.18em] text-[var(--muted-strong)]">
                Powered by
              </span>
              <span className="inline-flex max-w-full items-center rounded-full border border-white/10 bg-black px-2.5 py-1 font-medium text-white/84">
                🦒Web3Resear.ch
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="neutral">{supportedChains.length} Networks</StatusPill>
            {srcChain ? (
              <StatusPill tone="neutral">
                <span className="inline-flex items-center gap-1.5">
                  <AssetIcon
                    label={srcChain.shortName}
                    src={getStargateChainIconUrl(srcChain.chainKey)}
                    size="xs"
                  />
                  From {srcChain.shortName}
                </span>
              </StatusPill>
            ) : null}
            {dstChain ? (
              <StatusPill tone="neutral">
                <span className="inline-flex items-center gap-1.5">
                  <AssetIcon
                    label={dstChain.shortName}
                    src={getStargateChainIconUrl(dstChain.chainKey)}
                    size="xs"
                  />
                  To {dstChain.shortName}
                </span>
              </StatusPill>
            ) : null}
            <button
              type="button"
              onClick={() => {
                startTransition(() => {
                  setTokenDisplaySource((current) =>
                    current === "stargate" ? "layerzero" : "stargate",
                  );
                });
              }}
              className="inline-flex items-center justify-center rounded-full border border-white/12 bg-white/[0.04] px-3 py-2 text-xs font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08]"
            >
              {tokenDisplaySourceButtonCopy}
            </button>
            {isConnected ? (
              <>
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white">
                  {shortenAddress(address)}
                </span>
                <button type="button" onClick={() => disconnect()} className={GHOST_BUTTON_CLASS}>
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!injectedConnector || isConnectPending}
                onClick={() => {
                  if (injectedConnector) {
                    connect({ connector: injectedConnector });
                  }
                }}
                className={PRIMARY_BUTTON_CLASS}
              >
                {isConnectPending ? "Connecting..." : "Connect Wallet"}
              </button>
            )}
          </div>
        </header>

        <main className="grid flex-1 gap-3 xl:min-h-0 xl:grid-cols-[minmax(0,1.72fr)_420px]">
          <section
            id="transfer"
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] rounded-[1.75rem] border border-white/10 bg-[var(--panel)] p-4 shadow-[0_30px_100px_rgba(0,0,0,0.32)] backdrop-blur sm:p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              <div className="flex items-center gap-3">
                <StatusPill tone="neutral">Bridge</StatusPill>
                <p className="text-sm font-medium text-white">Transfer</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {quote ? <StatusPill tone="neutral">{availableQuoteCount} route(s)</StatusPill> : null}
                {executionState.transferStatus ? (
                  <StatusPill tone={executionTone}>{executionState.transferStatus}</StatusPill>
                ) : null}
              </div>
            </div>

            <div className="mt-3 grid min-h-0 gap-3 xl:grid-cols-2">
              <div className={`${SURFACE_CARD_CLASS} grid min-h-0 grid-rows-[auto_minmax(0,1fr)] p-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
                      From
                    </p>
                    <p className="mt-1 text-sm font-medium text-white">Origin</p>
                  </div>

                  <label className="block w-full max-w-[24rem] space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
                      Amount
                    </span>
                    <div className="rounded-[1.25rem] border border-white/10 bg-black px-4 py-3">
                      <div className="flex items-center gap-3">
                        <input
                          inputMode="decimal"
                          placeholder="0.00"
                          value={amountInput}
                          onChange={(event) => setAmountInput(event.target.value)}
                          className="min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[1.7rem] font-medium tracking-[-0.05em] text-white outline-none placeholder:text-white/35"
                        />
                        <button
                          type="button"
                          onClick={handleFillMax}
                          disabled={!canFillMax}
                          className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white/72 transition hover:border-white/24 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Max
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        <span className="mr-1">Balance</span>
                        {selectedSrcToken ? (
                          <InlineAssetLabel
                            label={selectedSrcTokenSymbol}
                            src={selectedSrcTokenIconUrl}
                          >
                            {balanceCopy}
                          </InlineAssetLabel>
                        ) : (
                          balanceCopy
                        )}
                      </p>
                    </div>
                  </label>
                </div>

                <div className="mt-3 grid min-h-0 flex-1 gap-3 sm:grid-cols-2">
                  <InlineOptionList
                    key={`src-chain-${srcChainKey}`}
                    title="Chain"
                    items={srcChainItems}
                    emptyState="No source chains."
                    loadingLabel={chainsQuery.isPending ? "Loading chains..." : null}
                  />

                  <InlineOptionList
                    key={`src-token-${srcChainKey}`}
                    title="Token"
                    items={srcTokenItems}
                    emptyState={srcChainKey ? "No source tokens." : "Select a source chain."}
                    loadingLabel={tokensQuery.isPending ? "Loading tokens..." : null}
                  />
                </div>
              </div>

              <div className={`${SURFACE_CARD_CLASS} grid min-h-0 grid-rows-[auto_minmax(0,1fr)] p-4`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
                      To
                    </p>
                    <p className="mt-1 text-sm font-medium text-white">Destination</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
                      Receive
                    </p>
                    <p className="mt-1.5 text-[1.65rem] font-medium tracking-[-0.05em] text-white">
                      {destinationPreviewAmount}
                    </p>
                    <p className="text-sm text-[var(--muted)]">
                      <InlineAssetLabel
                        label={selectedDstTokenSymbol}
                        src={selectedDstTokenIconUrl}
                      >
                        {selectedDstTokenSymbol}
                      </InlineAssetLabel>
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid min-h-0 flex-1 gap-3 sm:grid-cols-2">
                  <InlineOptionList
                    key={`dst-chain-${srcChainKey}-${dstChainKey}`}
                    title="Chain"
                    items={dstChainItems}
                    emptyState={srcChainKey ? "No destination chains." : "Select a source chain."}
                    loadingLabel={chainsQuery.isPending ? "Loading chains..." : null}
                  />

                  <InlineOptionList
                    key={`dst-token-${srcChainKey}-${srcTokenAddress}-${dstChainKey}`}
                    title="Token"
                    items={dstTokenItems}
                    emptyState={srcTokenAddress ? "No destination tokens." : "Select a source token first."}
                    loadingLabel={srcTokenAddress && routeTokensQuery.isPending ? "Loading routes..." : null}
                  />
                </div>
              </div>
            </div>

            {quoteError ? (
              <div className="mt-3 rounded-[1.25rem] border border-white/18 bg-white/[0.04] px-4 py-3 text-sm text-white">
                {quoteError}
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-start justify-between gap-2.5 rounded-[1.15rem] border border-white/10 bg-white/[0.03] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.45fr)_minmax(12rem,0.8fr)]">
                  <label className="block space-y-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                      Destination address
                    </span>
                    <input
                      placeholder="0x..."
                      value={destinationAddress}
                      onChange={(event) => setDestinationAddress(event.target.value)}
                      className={`${FIELD_CLASS} h-10 rounded-[1.05rem] px-3 py-2 text-xs`}
                    />
                  </label>

                  <div className="rounded-[1.05rem] border border-white/10 bg-black px-3 py-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                      Min receive
                    </p>
                    <p className="mt-1.5 text-xs text-white">
                      {selectedDstToken ? (
                        <InlineAssetLabel
                          label={selectedDstTokenSymbol}
                          src={selectedDstTokenIconUrl}
                        >
                          {minimumReceiveCopy ?? "Awaiting quote"}
                        </InlineAssetLabel>
                      ) : (
                        minimumReceiveCopy ?? "Awaiting quote"
                      )}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-nowrap items-center gap-2 self-start lg:justify-end">
                <button
                  type="button"
                  onClick={() => void handleRequestQuote("manual")}
                  disabled={!canRequestQuote || isQuoting}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 text-xs font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {refreshButtonCopy}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExecuteQuote()}
                  disabled={!canExecuteQuote}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-white px-4 py-2 text-xs font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {executionState.phase === "running" ? "Executing..." : "Execute"}
                </button>
              </div>
            </div>
          </section>

          <aside className="grid min-h-0 gap-3 rounded-[1.75rem] border border-white/10 bg-[var(--panel)] p-4 shadow-[0_30px_100px_rgba(0,0,0,0.32)] backdrop-blur sm:p-4 xl:grid-rows-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <section id="quote" className="flex min-h-0 flex-col rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-start justify-between gap-3">
                <SectionHeading eyebrow="Quote" title={quoteReady ? "Routes" : "Awaiting"} />
                {quote ? <StatusPill tone="neutral">{availableQuoteCount} route(s)</StatusPill> : null}
              </div>

              {quoteReady && quote && selectedSrcToken && selectedDstToken ? (
                <div className="mt-4 flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                    {quotes.map((candidate, index) => {
                      const routeKey = getQuoteRouteKey(candidate);
                      const isSelected = routeKey === selectedQuoteRouteKey;
                      const isBest = routeKey === bestQuoteRouteKey;

                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => setSelectedQuoteRouteKey(routeKey)}
                          className={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${
                            isSelected
                              ? "border-white bg-white text-black"
                              : "border-white/10 bg-black/70 text-white hover:border-white/24 hover:bg-black"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {formatQuoteRouteLabel(candidate)}
                              </p>
                              <p
                                className={`mt-1 text-xs ${
                                  isSelected ? "text-black/66" : "text-[var(--muted)]"
                                }`}
                              >
                                {formatEstimatedSeconds(candidate.duration?.estimated)} · Fee{" "}
                                {getQuoteFeeCopy(candidate)}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              {isBest ? (
                                <span
                                  className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${
                                    isSelected
                                      ? "border-black/10 bg-black/10 text-black/72"
                                      : "border-white/12 bg-white/[0.05] text-white/76"
                                  }`}
                                >
                                  Best
                                </span>
                              ) : null}
                              {isSelected ? (
                                <span className="inline-flex rounded-full border border-black/10 bg-black/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-black/72">
                                  Selected
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="mt-3 flex items-end justify-between gap-3">
                            <div>
                              <p
                                className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${
                                  isSelected ? "text-black/66" : "text-[var(--muted)]"
                                }`}
                              >
                                Receive
                              </p>
                              <p className="mt-1 text-base font-medium tracking-[-0.03em]">
                                <InlineAssetLabel
                                  label={selectedDstTokenSymbol}
                                  src={selectedDstTokenIconUrl}
                                >
                                  {formatTokenAmount(candidate.dstAmount, selectedDstToken.decimals)}{" "}
                                  {selectedDstTokenSymbol}
                                </InlineAssetLabel>
                              </p>
                            </div>
                            <p
                              className={`text-xs ${
                                isSelected ? "text-black/66" : "text-[var(--muted)]"
                              }`}
                            >
                              Option {index + 1}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
                  {isQuoting ? "Requesting live quote..." : "Fill the route to start live quotes."}
                </div>
              )}
            </section>

            <section
              id="history"
              className="flex min-h-0 flex-col rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <SectionHeading
                  eyebrow="Execution"
                  title="Transfers"
                  description={activeExecutionHistoryItem?.currentStep}
                />
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <StatusPill tone={executionTone}>{executionPhaseCopy}</StatusPill>
                  {executionHistory.length ? (
                    <StatusPill tone="neutral">{executionHistory.length} item(s)</StatusPill>
                  ) : null}
                </div>
              </div>

              {executionHistory.length ? (
                <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                  {executionHistory.map((item) => {
                    const itemTone = getExecutionTone(item.phase);
                    const isActive = item.id === executionState.activeHistoryId;

                    return (
                      <article
                        key={item.id}
                        className={`rounded-[1.25rem] border px-4 py-3 transition ${
                          isActive
                            ? "border-white/20 bg-black"
                            : "border-white/10 bg-black/70"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">
                              {item.srcChainName} to {item.dstChainName}
                            </p>
                            <p className="mt-1 truncate text-xs text-[var(--muted)]">
                              {item.routeLabel}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {isActive ? (
                              <span className="inline-flex rounded-full border border-white/12 bg-white/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/76">
                                Live
                              </span>
                            ) : null}
                            <StatusPill tone={itemTone}>{getExecutionHistoryStatus(item)}</StatusPill>
                          </div>
                        </div>

                        <div className="mt-3 rounded-[1.05rem] border border-white/10 bg-white/[0.02] px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                                Send
                              </p>
                              <p className="mt-1 truncate text-sm font-medium text-white">
                                <InlineAssetLabel label={item.srcTokenSymbol} src={item.srcTokenIconUrl}>
                                  {item.srcAmount}
                                </InlineAssetLabel>
                              </p>
                            </div>
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                              to
                            </span>
                            <div className="min-w-0 text-right">
                              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                                Receive
                              </p>
                              <p className="mt-1 truncate text-sm font-medium text-white">
                                <InlineAssetLabel label={item.dstTokenSymbol} src={item.dstTokenIconUrl}>
                                  {item.expectedDstAmount}
                                </InlineAssetLabel>
                              </p>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                            <InlineAssetLabel
                              label={item.srcChainName}
                              src={item.srcChainIconUrl}
                              className="text-white/76"
                            >
                              {item.srcChainName}
                            </InlineAssetLabel>
                            <span>to</span>
                            <InlineAssetLabel
                              label={item.dstChainName}
                              src={item.dstChainIconUrl}
                              className="text-white/76"
                            >
                              {item.dstChainName}
                            </InlineAssetLabel>
                            <span>·</span>
                            <span>{formatTimeLabel(item.updatedAt)}</span>
                          </div>
                        </div>

                        {item.currentStep ? (
                          <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
                            {item.currentStep}
                          </p>
                        ) : null}

                        {item.error ? (
                          <div className="mt-3 max-h-40 overflow-y-auto rounded-[1rem] border border-white/18 bg-white/[0.04] px-3 py-3 text-sm leading-6 text-white whitespace-pre-wrap break-words">
                            {item.error}
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {item.txHash ? (
                            <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-white/80">
                              Tx {shortenAddress(item.txHash)}
                            </span>
                          ) : null}
                          {item.minimumDstAmount ? (
                            <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-white/80">
                              Min {item.minimumDstAmount}
                            </span>
                          ) : null}
                          {item.explorerUrl ? (
                            <a
                              href={item.explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08]"
                            >
                              LayerZeroScan
                            </a>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-white/36">
                              LayerZeroScan pending
                            </span>
                          )}
                        </div>

                        <p className="mt-2 text-[11px] text-[var(--muted)]">
                          Destination {shortenAddress(item.destinationAddress)}
                        </p>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
                  No cross-chain execution yet.
                </div>
              )}
            </section>
          </aside>
        </main>
      </div>

      <div className="pointer-events-none fixed bottom-3 right-3 z-30 flex max-h-[calc(100vh-1.5rem)] w-[min(30rem,calc(100vw-1.5rem))] flex-col gap-2">
        {executionNotifications.map((notification) => (
          <div
            key={notification.id}
            className={`pointer-events-auto rounded-[1.25rem] border px-4 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur ${
              notification.tone === "success"
                ? "border-white/30 bg-white text-black"
                : notification.tone === "danger"
                  ? "border-white/18 bg-black text-white"
                  : "border-white/12 bg-[rgba(10,10,10,0.96)] text-white"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${
                      notification.tone === "success"
                        ? "border-black/10 bg-black/10 text-black/72"
                        : notification.tone === "danger"
                          ? "border-white/18 bg-white/[0.05] text-white"
                          : "border-white/12 bg-white/[0.05] text-white/84"
                    }`}
                  >
                    {notification.title}
                  </span>
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${
                      notification.tone === "success" ? "text-black/60" : "text-[var(--muted)]"
                    }`}
                  >
                    {formatTimeLabel(notification.createdAt)}
                  </span>
                </div>
                {notification.message ? (
                  <div
                    className={`mt-2 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 ${
                      notification.message.length > 180 ? "max-h-48" : ""
                    } ${
                      notification.tone === "success" ? "text-black/76" : "text-white/86"
                    }`}
                  >
                    {notification.message}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismissExecutionNotification(notification.id)}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] transition ${
                  notification.tone === "success"
                    ? "border-black/10 bg-black/10 text-black/70 hover:bg-black/15"
                    : "border-white/12 bg-white/[0.04] text-white/72 hover:border-white/24 hover:bg-white/[0.08]"
                }`}
              >
                Close
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
