"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  readContract,
  getAccount,
  getPublicClient,
  sendTransaction,
  signTypedData,
  waitForTransactionReceipt,
} from "wagmi/actions";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type {
  BridgeApiProvider,
  BridgeChain,
  BridgeQuote,
  BridgeQuoteResponse,
  BridgeStatusResponse,
  BridgeToken,
  BuildUserStepsResponse,
  CustomOftConfig,
  CustomOftDeployment,
  LayerZeroOftListEntry,
  LayerZeroOftListDeployment,
  LayerZeroOftListResponse,
  QuoteFee,
  QuoteUserStep,
  SignatureUserStep,
  SignatureTypedDataField,
  TransactionUserStep,
} from "@/lib/bridge-types";
import {
  canExecuteSourceChainType,
  getAddressValidationCopy,
  getChainTypeDisplayLabel,
  getDestinationAddressPlaceholder,
  getWalletConnectLabel,
  validateAddressForChainType,
} from "@/lib/bridge-chain-utils";
import { assertExecutionPlan, assertSuccessfulEvmReceipt } from "@/lib/execution-safety";
import { buildCustomOftQuote } from "@/lib/custom-oft-quote";
import { bridgeTokenKey, ccipTransferKey, supportsCcipPair } from "@/lib/ccip";
import { executeCcipTransfer } from "@/lib/ccip-execution";
import { buildDirectOftQuote, supportsDirectOftRoute } from "@/lib/direct-oft";
import { useBridgeWallets } from "@/lib/bridge-wallet-hooks";
import { checkSolanaSubmission, fetchExternalWalletBalance } from "@/lib/bridge-wallets";
import {
  isLocalCustomOftDestinationChainSupported,
  isLocalCustomOftSourceChainSupported,
  isSupportedCustomOftEndpointVersion,
} from "@/lib/custom-oft";
import {
  fetchInjectedEvmBalance,
  getConnectorEvmProvider,
  switchInjectedEvmChain,
} from "@/lib/injected-evm";
import {
  walletChainByKey,
  type SupportedChainId,
} from "@/lib/wagmi";
import { useRpcConfig } from "@/components/providers";
import { RpcSettingsModal } from "@/components/rpc-settings-modal";
import { WalletManagerModal } from "@/components/wallet-manager-modal";
import { ToggleSwitch } from "@/components/toggle-switch";
import { WALLET_NETWORKS, type WalletNetwork } from "@/lib/wallet-options";

import { SolanaConfirmationError } from "@/lib/solana-confirmation";

import { EXECUTION_HISTORY_KEY, loadExecutionHistory, mergeExecutionHistory, parseExecutionHistory, recoverExecutionHistory, type ExecutionHistoryItem } from "@/lib/execution-history";

const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "DELIVERED",
  "SUCCEEDED",
  "FAILED",
  "ERROR",
  "UNKNOWN",
  "CANCELLED",
]);
const FALLBACK_STARGATE_TOKEN_SYMBOL_ALIASES: Record<string, string> = {
  "arbitrum:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e",
  "optimism:0x7f5c764cbc14f9669b88837ca1490cca17c31607": "USDC.e",
  "polygon:0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC.e",
};
const STARGATE_ICONS_BASE_URL = "https://icons-ckg.pages.dev/stargate-light";
const BRIDGE_API_KEY_HEADER = "x-bridge-api-key";
const LAYERZERO_API_KEY_STORAGE_KEY = "earthbound.layerzero_api_key";
const CUSTOM_OFT_CONFIGS_STORAGE_KEY = "earthbound.custom_oft_configs.v1";
const GITHUB_REPOSITORY_URL = "https://github.com/c0mm4nd/earthbound";
const SURFACE_CARD_CLASS =
  "rounded-[1.75rem] border border-white/10 bg-[var(--surface-strong)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:p-5";
const FIELD_CLASS =
  "w-full rounded-[1.25rem] border border-white/10 bg-black px-3 py-2 text-xs text-white outline-none transition placeholder:text-white/35 focus:border-white/28";
const GHOST_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full border border-white/12 bg-white/[0.04] h-9 px-3 text-xs font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full bg-white h-9 px-3 text-xs font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BUTTON_CLASS =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/76 transition hover:border-white/24 hover:bg-white/[0.08] hover:text-white";

type ExecutionPhase = "idle" | "running" | "pending" | "success" | "error";

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



type TokenDisplaySource = "stargate" | "layerzero";

type InlineOptionItem = {
  key: string;
  badgeText: string;
  iconUrl?: string;
  iconBadgeLabel?: string;
  iconBadgeUrl?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  searchTerms?: string[];
  selected?: boolean;
  onSelect: () => void;
};

type CustomOftConfigDraft = {
  id?: string;
  json: string;
};

type OftDiscoveryImportPayload = {
  name: string;
  symbol: string;
  endpointVersion?: string;
  deployments: Record<string, CustomOftDeployment>;
};

type OftDiscoveryEntry = {
  key: string;
  name: string;
  symbol: string;
  endpointVersion?: string;
  sharedDecimals?: number;
  deployments: CustomOftDeploymentWithChainKey[];
};

type CustomOftDeploymentWithChainKey = LayerZeroOftListDeployment & {
  chainKey: string;
};

function getBridgeApiRequestHeaders(
  provider: BridgeApiProvider,
  apiKey?: string | null,
): HeadersInit | undefined {
  if (provider !== "layerzero") {
    return undefined;
  }

  const normalizedApiKey = apiKey?.trim();

  if (!normalizedApiKey) {
    return undefined;
  }

  return {
    [BRIDGE_API_KEY_HEADER]: normalizedApiKey,
  };
}

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

function formatTransferStatus(status: string) {
  const labels: Record<string, string> = {
    SOURCE_CONFIRMED: "Source confirmed",
    SUBMITTED: "Confirming transaction",
    CONFIRMATION_PENDING: "Awaiting confirmation",
    COMPLETED: "Transfer completed",
    DELIVERED: "Transfer completed",
    SUCCEEDED: "Transfer completed",
    FAILED: "Transfer failed",
    ERROR: "Transfer failed",
    CANCELLED: "Transfer cancelled",
    EXPIRED: "Transaction expired",
    UNKNOWN: "Status unavailable",
    PENDING: "Transfer pending",
    ACTION_REQUIRED: "Needs attention",
    INFLIGHT: "Transfer in progress",
  };
  return labels[status] ?? status.replace(/[_-]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function formatExecutionCopy(value: string) {
  return value.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, formatTransferStatus);
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

  return bridgeTokenKey(token);
}

function compareBridgeTokens(left: BridgeToken, right: BridgeToken) {
  const leftScore = Number(left.price?.usd ?? 0);
  const rightScore = Number(right.price?.usd ?? 0);

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  const symbolCompare = left.symbol.localeCompare(right.symbol);

  if (symbolCompare !== 0) {
    return symbolCompare;
  }

  return left.chainKey.localeCompare(right.chainKey);
}

function isMatchingSelectedToken(
  token: Pick<BridgeToken, "address" | "chainKey">,
  chainKey: string,
  tokenAddress: string,
) {
  if (!chainKey || !tokenAddress) {
    return false;
  }

  return bridgeTokenKey(token) === bridgeTokenKey({ chainKey, address: tokenAddress });
}

function buildTokenOptionSubtitle(name: string, chain?: Pick<BridgeChain, "shortName"> | null) {
  return chain ? `${name} · ${chain.shortName}` : name;
}

function buildTokenOptionMeta(
  chain: Pick<BridgeChain, "shortName"> | null | undefined,
  priceUsd: number | undefined,
) {
  const parts = [
    chain?.shortName,
    priceUsd !== undefined ? (formatUsd(priceUsd) ?? undefined) : undefined,
  ].filter(Boolean);

  return parts.length ? parts.join(" · ") : undefined;
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

function formatFeeUsd(value: number | string | undefined) {
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
    maximumFractionDigits:
      numeric >= 100 ? 2 : numeric >= 1 ? 4 : numeric >= 0.01 ? 5 : numeric >= 0.001 ? 6 : 8,
  }).format(numeric);
}

function formatEstimatedDuration(milliseconds: number | undefined | null) {
  const numeric = milliseconds;

  if (!numeric || !Number.isFinite(numeric)) {
    return "Unknown";
  }

  const seconds = Math.max(1, Math.round(numeric / 1_000));
  const minutes = Math.round(numeric / 60_000);

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatQuoteEstimate(estimated: string | number | undefined | null) {
  if (estimated === undefined || estimated === null) {
    return "Timing unknown";
  }

  const numeric = typeof estimated === "string" ? Number(estimated.trim()) : estimated;

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "Timing unknown";
  }

  // VT/v2 quote APIs return milliseconds. Keep a small-value fallback for legacy second-based shapes.
  const durationMs = numeric >= 1_000 ? numeric : numeric * 1_000;

  return `Est. ${formatEstimatedDuration(durationMs)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createStableId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeIdentityAddress(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function isLikelyOftContractAddress(value: string) {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return false;
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(normalizedValue)) {
    return true;
  }

  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(normalizedValue);
}

function getLayerZeroScanUrl(txHash?: string) {
  return txHash ? `https://layerzeroscan.com/tx/${txHash}` : undefined;
}

function getSortedCustomOftDeployments(config?: Pick<CustomOftConfig, "deployments"> | null) {
  return Object.values(config?.deployments ?? {}).sort((left, right) =>
    left.chainKey.localeCompare(right.chainKey),
  );
}

function createCustomOftJsonTemplate(sourceChainKey = "ethereum", destinationChainKey = "base") {
  const chainKeys = [sourceChainKey, destinationChainKey].filter(
    (chainKey, index, current) => chainKey && current.indexOf(chainKey) === index,
  );
  const placeholderAddresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ];

  return JSON.stringify(
    {
      OFT: [
        {
          name: "My OFT",
          endpointVersion: "v2",
          deployments: Object.fromEntries(
            chainKeys.map((chainKey, index) => [
              chainKey,
              {
                address:
                  placeholderAddresses[index] ??
                  "0x3333333333333333333333333333333333333333",
                localDecimals: 18,
                type: "OFT",
              } satisfies LayerZeroOftListDeployment,
            ]),
          ),
        } satisfies LayerZeroOftListEntry,
      ],
    } satisfies LayerZeroOftListResponse,
    null,
    2,
  );
}

function serializeCustomOftConfig(config: CustomOftConfig): LayerZeroOftListEntry {
  return {
    name: config.name,
    endpointVersion: config.endpointVersion,
    deployments: Object.fromEntries(
      getSortedCustomOftDeployments(config).map((deployment) => [
        deployment.chainKey,
        {
          address: deployment.oftAddress,
          innerTokenAddress: deployment.tokenAddress,
          localDecimals: deployment.decimals,
          approvalRequired: deployment.approvalRequired,
          type: deployment.type,
        } satisfies LayerZeroOftListDeployment,
      ]),
    ),
  };
}

function serializeCustomOftConfigs(configs: CustomOftConfig[]): LayerZeroOftListResponse {
  const response: LayerZeroOftListResponse = {};

  for (const config of configs) {
    const symbol = config.symbol.trim().toUpperCase();

    if (!symbol) {
      continue;
    }

    response[symbol] = [...(response[symbol] ?? []), serializeCustomOftConfig(config)];
  }

  return Object.fromEntries(
    Object.entries(response).sort(([leftSymbol, leftEntries], [rightSymbol, rightEntries]) => {
      const symbolCompare = leftSymbol.localeCompare(rightSymbol);

      if (symbolCompare !== 0) {
        return symbolCompare;
      }

      return (leftEntries[0]?.name ?? leftSymbol).localeCompare(rightEntries[0]?.name ?? rightSymbol);
    }),
  );
}

function parseCustomOftDeployment(
  value: unknown,
  fallbackChainKey?: string,
): CustomOftDeployment | null {
  if (!isRecord(value)) {
    return null;
  }

  const chainKey =
    typeof value.chainKey === "string" && value.chainKey.trim()
      ? value.chainKey.trim()
      : (fallbackChainKey?.trim() ?? "");
  const oftAddress =
    typeof value.oftAddress === "string"
      ? value.oftAddress.trim()
      : typeof value.address === "string"
        ? value.address.trim()
        : "";
  const tokenAddress =
    typeof value.tokenAddress === "string"
      ? value.tokenAddress.trim()
      : typeof value.innerTokenAddress === "string"
        ? value.innerTokenAddress.trim()
        : "";
  const rawDecimals =
    typeof value.decimals === "number" || typeof value.decimals === "string"
      ? value.decimals
      : typeof value.localDecimals === "number" || typeof value.localDecimals === "string"
        ? value.localDecimals
        : typeof value.sharedDecimals === "number" || typeof value.sharedDecimals === "string"
          ? value.sharedDecimals
          : undefined;
  const decimals =
    typeof rawDecimals === "number"
      ? rawDecimals
      : typeof rawDecimals === "string"
        ? Number.parseInt(rawDecimals, 10)
        : Number.NaN;
  const approvalRequired =
    typeof value.approvalRequired === "boolean" ? value.approvalRequired : undefined;
  const type = typeof value.type === "string" && value.type.trim() ? value.type.trim() : undefined;

  if (!chainKey || !oftAddress || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return null;
  }

  return {
    chainKey,
    oftAddress,
    tokenAddress: tokenAddress || undefined,
    decimals,
    approvalRequired,
    type,
  };
}

function normalizeCustomOftDeployments(value: unknown) {
  const deployments: Record<string, CustomOftDeployment> = {};

  if (Array.isArray(value)) {
    for (const item of value) {
      const deployment = parseCustomOftDeployment(item);

      if (deployment) {
        deployments[deployment.chainKey] = deployment;
      }
    }

    return deployments;
  }

  if (!isRecord(value)) {
    return deployments;
  }

  for (const [chainKey, deploymentValue] of Object.entries(value)) {
    const deployment = parseCustomOftDeployment(deploymentValue, chainKey);

    if (deployment) {
      deployments[deployment.chainKey] = deployment;
    }
  }

  return deployments;
}

function parseLayerZeroOftListConfigs(value: unknown) {
  if (!isRecord(value)) {
    return [] as CustomOftConfig[];
  }

  return Object.entries(value).flatMap(([symbolKey, variants]) => {
    const symbol = symbolKey.trim().toUpperCase();

    if (!symbol || !Array.isArray(variants)) {
      return [];
    }

    return variants.flatMap((variant) => {
      if (!isRecord(variant)) {
        return [];
      }

      const name =
        typeof variant.name === "string" && variant.name.trim() ? variant.name.trim() : symbol;
      const endpointVersion =
        typeof variant.endpointVersion === "string" && variant.endpointVersion.trim()
          ? variant.endpointVersion.trim()
          : undefined;
      const deployments = normalizeCustomOftDeployments(variant.deployments);

      if (!Object.keys(deployments).length) {
        return [];
      }

      return [
        {
          id: createStableId(),
          name,
          symbol,
          endpointVersion,
          deployments,
        } satisfies CustomOftConfig,
      ];
    });
  });
}

function validateCustomOftConfig(
  config: CustomOftConfig,
  chainByKey: Map<string, BridgeChain>,
) {
  if (!config.name.trim()) {
    return "Enter a config name.";
  }

  if (!config.symbol.trim()) {
    return "Enter a token symbol.";
  }

  const deployments = getSortedCustomOftDeployments(config);

  if (deployments.length < 2) {
    return `Add at least two deployments for ${config.symbol.trim().toUpperCase()}.`;
  }

  for (const [index, deployment] of deployments.entries()) {
    const chain = chainByKey.get(deployment.chainKey);

    if (!chain) {
      return `Choose a valid chain for deployment ${index + 1}.`;
    }

    if (!validateAddressForChainType(chain.chainType, deployment.oftAddress)) {
      return `Enter a valid OFT address for ${chain.shortName}.`;
    }

    if (
      deployment.tokenAddress &&
      !validateAddressForChainType(chain.chainType, deployment.tokenAddress)
    ) {
      return `Enter a valid spend token address for ${chain.shortName}.`;
    }

    if (
      !Number.isInteger(deployment.decimals) ||
      deployment.decimals < 0 ||
      deployment.decimals > 255
    ) {
      return `Enter a valid decimals value for ${chain.shortName}.`;
    }
  }

  if (
    !deployments.some((deployment) => {
      const chain = chainByKey.get(deployment.chainKey);

      return chain && isLocalCustomOftSourceChainSupported(chain.chainType);
    })
  ) {
    return `Add at least one EVM deployment as a source chain for ${config.symbol.trim().toUpperCase()}.`;
  }

  return null;
}

function validateCustomOftConfigs(
  configs: CustomOftConfig[],
  chainByKey: Map<string, BridgeChain>,
) {
  for (const config of configs) {
    const error = validateCustomOftConfig(config, chainByKey);

    if (error) {
      return error;
    }
  }

  return null;
}

function getCustomOftDeploymentIdentity(
  deployment: Pick<CustomOftDeployment, "chainKey" | "oftAddress">,
) {
  return [
    deployment.chainKey.trim().toLowerCase(),
    normalizeIdentityAddress(deployment.oftAddress),
  ].join("|");
}

function getCustomOftConfigIdentity(config: Pick<CustomOftConfig, "deployments">) {
  return Object.values(config.deployments)
    .map((deployment) => getCustomOftDeploymentIdentity(deployment))
    .filter(Boolean)
    .sort()
    .join("||");
}

function mergeCustomOftDeployments(
  existingDeployment: CustomOftDeployment,
  incomingDeployment: CustomOftDeployment,
): CustomOftDeployment {
  return {
    chainKey: incomingDeployment.chainKey,
    oftAddress: incomingDeployment.oftAddress,
    tokenAddress: incomingDeployment.tokenAddress ?? existingDeployment.tokenAddress,
    decimals: incomingDeployment.decimals,
    approvalRequired: incomingDeployment.approvalRequired ?? existingDeployment.approvalRequired,
    type: incomingDeployment.type ?? existingDeployment.type,
  };
}

function canMergeCustomOftConfigs(left: CustomOftConfig, right: CustomOftConfig) {
  if (left.symbol.trim().toLowerCase() !== right.symbol.trim().toLowerCase()) {
    return false;
  }

  const leftName = left.name.trim().toLowerCase();
  const rightName = right.name.trim().toLowerCase();

  if (leftName && rightName && leftName !== rightName) {
    return false;
  }

  const leftDeploymentIdentities = new Set(
    Object.values(left.deployments).map((deployment) => getCustomOftDeploymentIdentity(deployment)),
  );

  return Object.values(right.deployments).some((deployment) =>
    leftDeploymentIdentities.has(getCustomOftDeploymentIdentity(deployment)),
  );
}

function mergeCustomOftConfigs(existingConfig: CustomOftConfig, incomingConfig: CustomOftConfig) {
  const deployments = { ...existingConfig.deployments };

  for (const deployment of getSortedCustomOftDeployments(incomingConfig)) {
    deployments[deployment.chainKey] = deployments[deployment.chainKey]
      ? mergeCustomOftDeployments(deployments[deployment.chainKey], deployment)
      : deployment;
  }

  return {
    id: existingConfig.id,
    name:
      incomingConfig.name.trim().length >= existingConfig.name.trim().length
        ? incomingConfig.name
        : existingConfig.name,
    symbol: incomingConfig.symbol || existingConfig.symbol,
    endpointVersion: incomingConfig.endpointVersion ?? existingConfig.endpointVersion,
    deployments,
  } satisfies CustomOftConfig;
}

function consolidateCustomOftConfigs(configs: CustomOftConfig[]) {
  const consolidatedConfigs: CustomOftConfig[] = [];

  for (const config of configs) {
    const matchingConfigIndex = consolidatedConfigs.findIndex(
      (candidate) =>
        candidate.id === config.id ||
        getCustomOftConfigIdentity(candidate) === getCustomOftConfigIdentity(config) ||
        canMergeCustomOftConfigs(candidate, config),
    );

    if (matchingConfigIndex === -1) {
      consolidatedConfigs.push(config);
      continue;
    }

    consolidatedConfigs[matchingConfigIndex] = mergeCustomOftConfigs(
      consolidatedConfigs[matchingConfigIndex],
      config,
    );
  }

  return consolidatedConfigs;
}

function parseStoredCustomOftConfigs(value: string | null) {
  if (!value) {
    return [] as CustomOftConfig[];
  }

  try {
    const parsedValue = JSON.parse(value) as unknown;

    if (isRecord(parsedValue) && !Array.isArray(parsedValue)) {
      const layerZeroConfigs = parseLayerZeroOftListConfigs(parsedValue);

      if (layerZeroConfigs.length) {
        return consolidateCustomOftConfigs(layerZeroConfigs);
      }
    }

    if (!Array.isArray(parsedValue)) {
      return [] as CustomOftConfig[];
    }

    return consolidateCustomOftConfigs(
      parsedValue.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : createStableId();
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
      const endpointVersion =
        typeof item.endpointVersion === "string" && item.endpointVersion.trim()
          ? item.endpointVersion.trim()
          : undefined;
      const deployments = normalizeCustomOftDeployments(item.deployments);

      if (name && symbol && Object.keys(deployments).length) {
        return [
          {
            id,
            name,
            symbol,
            endpointVersion,
            deployments,
          } satisfies CustomOftConfig,
        ];
      }

      const srcChainKey = typeof item.srcChainKey === "string" ? item.srcChainKey.trim() : "";
      const dstChainKey = typeof item.dstChainKey === "string" ? item.dstChainKey.trim() : "";
      const srcOftAddress =
        typeof item.srcOftAddress === "string" ? item.srcOftAddress.trim() : "";
      const srcTokenAddress =
        typeof item.srcTokenAddress === "string" ? item.srcTokenAddress.trim() : "";
      const dstOftAddress =
        typeof item.dstOftAddress === "string" ? item.dstOftAddress.trim() : "";
      const rawDecimals = item.decimals;
      const decimals =
        typeof rawDecimals === "number"
          ? rawDecimals
          : typeof rawDecimals === "string"
            ? Number.parseInt(rawDecimals, 10)
            : Number.NaN;

      if (
        !name ||
        !symbol ||
        !srcChainKey ||
        !dstChainKey ||
        !srcOftAddress ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 255
      ) {
        return [];
      }

      return [
        {
          id,
          name,
          symbol,
          deployments: {
            [srcChainKey]: {
              chainKey: srcChainKey,
              oftAddress: srcOftAddress,
              tokenAddress: srcTokenAddress || undefined,
              decimals,
            },
            [dstChainKey]: {
              chainKey: dstChainKey,
              oftAddress: dstOftAddress || srcOftAddress,
              decimals,
            },
          },
        } satisfies CustomOftConfig,
      ];
      }),
    );
  } catch {
    return [] as CustomOftConfig[];
  }
}

function upsertCustomOftConfig(existingConfigs: CustomOftConfig[], nextConfig: CustomOftConfig) {
  const nextIdentity = getCustomOftConfigIdentity(nextConfig);
  const meshDuplicate = existingConfigs.find(
    (config) =>
      config.id !== nextConfig.id && getCustomOftConfigIdentity(config) === nextIdentity,
  );
  const exactMatch = existingConfigs.find((config) => config.id === nextConfig.id);
  const storedConfigId = meshDuplicate?.id ?? exactMatch?.id ?? nextConfig.id;
  const storedConfig = meshDuplicate
    ? mergeCustomOftConfigs(meshDuplicate, {
        ...nextConfig,
        id: storedConfigId,
      })
    : exactMatch
      ? mergeCustomOftConfigs(exactMatch, {
          ...nextConfig,
          id: storedConfigId,
        })
      : {
          ...nextConfig,
          id: storedConfigId,
        };

  return {
    storedConfig: storedConfig,
    mode: meshDuplicate
      ? ("updated_duplicate" as const)
      : exactMatch
        ? ("updated_existing" as const)
        : ("created" as const),
    configs: dedupeCustomOftConfigs([
      storedConfig,
      ...existingConfigs.filter(
        (config) => config.id !== storedConfig.id && config.id !== nextConfig.id,
      ),
    ]),
  };
}

function dedupeCustomOftConfigs(configs: CustomOftConfig[]) {
  const consolidatedConfigs = consolidateCustomOftConfigs(configs);
  const seenIdentities = new Set<string>();

  return consolidatedConfigs.filter((config) => {
    const identity = getCustomOftConfigIdentity(config);

    if (!identity || seenIdentities.has(identity)) {
      return false;
    }

    seenIdentities.add(identity);
    return true;
  });
}

function mergeImportedCustomOftConfigs(
  existingConfigs: CustomOftConfig[],
  importedConfigs: CustomOftConfig[],
) {
  let nextConfigs = existingConfigs;
  let createdCount = 0;
  let updatedCount = 0;

  for (const importedConfig of importedConfigs) {
    const result = upsertCustomOftConfig(nextConfigs, importedConfig);
    nextConfigs = result.configs;

    if (result.mode === "created") {
      createdCount += 1;
    } else {
      updatedCount += 1;
    }
  }

  return {
    configs: dedupeCustomOftConfigs(nextConfigs),
    createdCount,
    updatedCount,
  };
}

function normalizeOftDiscoveryEntries(
  response: LayerZeroOftListResponse,
  supportedChains: BridgeChain[],
) {
  const supportedChainKeys = new Set(supportedChains.map((chain) => chain.chainKey));
  const entries: OftDiscoveryEntry[] = [];

  for (const [symbol, variants] of Object.entries(response)) {
    if (!Array.isArray(variants)) {
      continue;
    }

    for (const [index, variant] of variants.entries()) {
      const deploymentsObject = isRecord(variant.deployments) ? variant.deployments : {};
      const deployments = Object.entries(deploymentsObject)
        .flatMap(([chainKey, deployment]) => {
          if (!supportedChainKeys.has(chainKey) || !isRecord(deployment)) {
            return [];
          }

          const address =
            typeof deployment.address === "string" ? deployment.address.trim() : "";

          if (!address) {
            return [];
          }

          return [
            {
              chainKey,
              address,
              localDecimals:
                typeof deployment.localDecimals === "number"
                  ? deployment.localDecimals
                  : undefined,
              sharedDecimals:
                typeof deployment.sharedDecimals === "number"
                  ? deployment.sharedDecimals
                  : undefined,
              innerTokenAddress:
                typeof deployment.innerTokenAddress === "string"
                  ? deployment.innerTokenAddress
                  : undefined,
              approvalRequired:
                typeof deployment.approvalRequired === "boolean"
                  ? deployment.approvalRequired
                  : undefined,
              type: typeof deployment.type === "string" ? deployment.type : undefined,
            } satisfies LayerZeroOftListDeployment & {
              chainKey: string;
            },
          ];
        })
        .sort((left, right) => left.chainKey.localeCompare(right.chainKey));

      if (!deployments.length) {
        continue;
      }

      entries.push({
        key: `${symbol}:${variant.name ?? symbol}:${index}`,
        name: typeof variant.name === "string" && variant.name.trim() ? variant.name : symbol,
        symbol,
        endpointVersion:
          typeof variant.endpointVersion === "string" ? variant.endpointVersion : undefined,
        sharedDecimals:
          typeof variant.sharedDecimals === "number" ? variant.sharedDecimals : undefined,
        deployments,
      });
    }
  }

  return entries.sort((left, right) => {
    const symbolCompare = left.symbol.localeCompare(right.symbol);

    if (symbolCompare !== 0) {
      return symbolCompare;
    }

    return left.name.localeCompare(right.name);
  });
}

function compareQuotes(left: BridgeQuote, right: BridgeQuote) {
  const leftAmount = BigInt(left.dstAmount);
  const rightAmount = BigInt(right.dstAmount);

  if (leftAmount === rightAmount) {
    const leftFee = getQuoteFeeUsdValue(left);
    const rightFee = getQuoteFeeUsdValue(right);
    return leftFee === rightFee ? 0 : leftFee - rightFee;
  }

  return rightAmount > leftAmount ? 1 : -1;
}

function getQuoteRouteKey(quote: BridgeQuote) {
  return quote.routeSteps.map((step) => step.type).join("|");
}

function formatRouteType(type: string) {
  const labels: Record<string, string> = {
    DIRECT_OFT: "Direct transfer",
    CCIP: "CCIP",
    STARGATE_V2_TAXI: "Fast transfer",
    STARGATE_V2_BUS: "Economy transfer",
    STARGATE_V1: "Standard transfer",
    STARGATE_V2_HYPERCORE: "HyperCore transfer",
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

function formatHistoryRouteLabel(label: string) {
  return label
    .replace(/Direct OFT · no Stargate product fee/g, "Direct transfer")
    .replace(/Stargate Fast/g, "Fast transfer")
    .replace(/Stargate Economy/g, "Economy transfer")
    .replace(/Stargate V1/g, "Standard transfer")
    .replace(/Stargate HyperCore/g, "HyperCore transfer");
}

function formatQuoteRouteLabel(quote: BridgeQuote) {
  if (!quote.routeSteps.length) {
    return "Route unavailable";
  }

  return quote.routeSteps.map((step) => formatRouteType(step.type)).join(" · ");
}

function getQuoteFeeCopy(quote: BridgeQuote) {
  const singleFeeCopy = getSingleQuoteFeeCopy(quote.fees);

  if (singleFeeCopy) {
    return singleFeeCopy;
  }

  const directFee = formatFeeUsd(quote.feeUsd);

  if (directFee) {
    return directFee;
  }

  return getFeeTotalUsd(quote.fees) ?? quote.fees?.map(fee => getSingleQuoteFeeCopy([fee]) ?? "Unknown").join(" + ") ?? "Unknown";
}

function getFeeTotalUsd(fees?: QuoteFee[]) {
  if (!fees?.length || fees.some((fee) => fee.amountUsd === undefined || !Number.isFinite(Number(fee.amountUsd)))) {
    return null;
  }

  const total = fees.reduce((sum, fee) => sum + Number(fee.amountUsd ?? 0), 0);

  return formatFeeUsd(total);
}

function getQuoteFeeUsdValue(quote: BridgeQuote) {
  if (quote.feeUsd !== undefined && quote.feeUsd !== "" && Number.isFinite(Number(quote.feeUsd))) return Number(quote.feeUsd);
  if (!quote.fees?.length || quote.fees.some(fee => fee.amountUsd === undefined || fee.amountUsd === "" || !Number.isFinite(Number(fee.amountUsd)))) return Infinity;
  return quote.fees.reduce((sum, fee) => sum + Number(fee.amountUsd), 0);
}

function getSingleQuoteFeeCopy(fees?: QuoteFee[]) {
  if (!fees || fees.length !== 1) {
    return null;
  }

  const [fee] = fees;

  if (!fee?.amount || fee.decimals === undefined || !fee.symbol) {
    return null;
  }

  const amountCopy = formatTokenAmount(fee.amount, fee.decimals, 8);
  const usdCopy = formatFeeUsd(fee.amountUsd);

  return usdCopy ? `${amountCopy} ${fee.symbol} (${usdCopy})` : `${amountCopy} ${fee.symbol}`;
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
  provider: BridgeApiProvider,
  apiKey?: string,
  txHash?: string,
  onUpdate?: (status: BridgeStatusResponse) => void,
) {
  let latest: BridgeStatusResponse | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const searchParams = new URLSearchParams();

    if (txHash) {
      searchParams.set("txHash", txHash);
    }

    searchParams.set("provider", provider);
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const status = await fetchJson<BridgeStatusResponse>(
      `/api/bridge/status/${encodeURIComponent(quoteId)}${query}`,
      {
        headers: getBridgeApiRequestHeaders(provider, apiKey),
      },
    );
    latest = status;
    onUpdate?.(status);

    if (TRANSFER_TERMINAL_STATUSES.has(status.status) || status.status === "ACTION_REQUIRED") {
      return status;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 4_000));
  }

  return latest;
}

async function buildUserSteps(
  quoteId: string,
  provider: BridgeApiProvider,
  apiKey?: string,
) {
  return fetchJson<BuildUserStepsResponse>("/api/bridge/build-user-steps", {
    method: "POST",
    headers: getBridgeApiRequestHeaders(provider, apiKey),
    body: JSON.stringify({
      provider,
      quoteId,
    }),
  });
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
  if (phase === "pending") return "Pending";
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
  return item.transferStatus ? formatTransferStatus(item.transferStatus) : getExecutionPhaseLabel(item.phase);
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
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses}`}
    >
      {children}
    </span>
  );
}

function GitHubIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.648.5.5 5.648.5 12c0 5.084 3.292 9.399 7.86 10.92.575.106.786-.25.786-.556 0-.274-.01-1-.016-1.963-3.197.695-3.872-1.541-3.872-1.541-.523-1.329-1.277-1.683-1.277-1.683-1.044-.714.079-.7.079-.7 1.155.081 1.763 1.186 1.763 1.186 1.026 1.758 2.692 1.25 3.349.956.104-.743.402-1.25.731-1.538-2.552-.29-5.236-1.276-5.236-5.68 0-1.255.449-2.281 1.184-3.085-.119-.29-.513-1.457.113-3.038 0 0 .965-.309 3.162 1.178a10.986 10.986 0 0 1 5.758 0c2.195-1.487 3.158-1.178 3.158-1.178.628 1.581.234 2.748.115 3.038.737.804 1.182 1.83 1.182 3.085 0 4.415-2.688 5.386-5.248 5.67.413.355.781 1.058.781 2.133 0 1.54-.014 2.782-.014 3.16 0 .309.207.668.791.555C20.212 21.395 23.5 17.082 23.5 12 23.5 5.648 18.352.5 12 .5Z" />
    </svg>
  );
}

function SettingsIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ArrowRightIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function LinkIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ArrowDownIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

function KeyIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5l3 3" />
    </svg>
  );
}

function RefreshIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function SendIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function SwitchIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function WalletIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <circle cx="17" cy="13" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function XIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "min-w-0 space-y-0.5" : "min-w-0 space-y-2"}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
        {eyebrow}
      </p>
      <h2 className={`font-medium tracking-[-0.03em] text-white ${compact ? "text-sm" : "text-lg"}`}>{title}</h2>
      {description ? (
        <p
          className={`max-w-2xl break-words leading-6 text-[var(--muted)] ${
            compact ? "text-xs" : "text-sm"
          }`}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

function AssetIconBadge({
  label,
  src,
  size = "sm",
}: {
  label: string;
  src?: string;
  size?: "xs" | "sm" | "md";
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const content = label.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
  const sizeClass =
    size === "xs"
      ? "h-3.5 w-3.5 text-[6px]"
      : size === "sm"
        ? "h-[1.125rem] w-[1.125rem] text-[7px]"
        : "h-5 w-5 text-[8px]";

  if (!src || hasImageError) {
    return (
      <span
        className={`inline-flex ${sizeClass} items-center justify-center overflow-hidden rounded-full border border-[var(--panel)] bg-black font-semibold uppercase tracking-[0.12em] text-white`}
        aria-hidden="true"
      >
        {content}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex ${sizeClass} items-center justify-center overflow-hidden rounded-full border border-[var(--panel)] bg-black`}
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

function AssetIcon({
  label,
  src,
  badgeLabel,
  badgeSrc,
  size = "md",
}: {
  label: string;
  src?: string;
  badgeLabel?: string;
  badgeSrc?: string;
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
        className={`relative inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.06] font-semibold uppercase tracking-[0.18em] text-white`}
        aria-hidden="true"
      >
        {content}
        {badgeLabel ? (
          <span className="pointer-events-none absolute -right-0.5 -bottom-0.5">
            <AssetIconBadge label={badgeLabel} src={badgeSrc} size={size} />
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={`relative inline-flex ${sizeClass} shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white/[0.06]`}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        onError={() => setHasImageError(true)}
      />
      {badgeLabel ? (
        <span className="pointer-events-none absolute -right-0.5 -bottom-0.5">
          <AssetIconBadge label={badgeLabel} src={badgeSrc} size={size} />
        </span>
      ) : null}
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
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`.trim()}>
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
  const hasVisibleItems = filteredItems.length > 0;
  const showBlockingLoader = Boolean(loadingLabel && !items.length && !normalizedQuery);

  return (
    <div className="wallet-option-list flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
          {title}
        </p>
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${title.toLowerCase()}`}
        className={`${FIELD_CLASS} h-10 px-3 py-2 text-xs`}
      />

      {loadingLabel && hasVisibleItems ? (
        <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
          {loadingLabel}
        </p>
      ) : null}

      {showBlockingLoader ? (
        <div className="flex min-h-0 flex-1 items-center rounded-[1.25rem] border border-white/10 bg-black px-4 py-3 text-sm text-[var(--muted)]">
          {loadingLabel}
        </div>
      ) : hasVisibleItems ? (
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
              <AssetIcon
                label={item.badgeText}
                src={item.iconUrl}
                badgeLabel={item.iconBadgeLabel}
                badgeSrc={item.iconBadgeUrl}
                size="sm"
              />
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

function LayerZeroApiKeyModal({
  apiKey,
  error,
  onApiKeyChange,
  onClose,
  onSubmit,
}: {
  apiKey: string;
  error?: string | null;
  onApiKeyChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[1.6rem] border border-white/12 bg-[var(--overlay-surface)] p-5 shadow-[0_32px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              LayerZero
            </p>
            <h2 className="mt-2 text-lg font-medium tracking-[-0.03em] text-white">
              Direct API Key
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Enter your LayerZero Transfer API key before switching to Direct API mode. Leave it
              blank to use the default API routes. The key is stored only in this browser.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={ICON_BUTTON_CLASS}
            aria-label="Close LayerZero API key dialog"
          >
            <XIcon />
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              API Key
            </span>
            <input
              type="password"
              autoFocus
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder="lz_..."
              className={FIELD_CLASS}
            />
          </label>

          {error ? (
            <div className="rounded-[1rem] border border-white/18 bg-white/[0.04] px-3 py-2.5 text-sm text-white">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={GHOST_BUTTON_CLASS}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CustomOftConfigModal({
  draft,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: CustomOftConfigDraft;
  error?: string | null;
  onChange: (patch: Partial<CustomOftConfigDraft>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm">
      <div className="w-full max-w-4xl rounded-[1.6rem] border border-white/12 bg-[var(--overlay-surface)] p-5 shadow-[0_32px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              Custom OFT
            </p>
            <h2 className="mt-2 text-lg font-medium tracking-[-0.03em] text-white">
              {draft.id ? "Edit manual JSON" : "Manual JSON"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Paste the same JSON shape returned by LayerZero OFT discovery `GET /list`. Each top-
              level key is a symbol, and each value is an array of OFT meshes for that symbol.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={ICON_BUTTON_CLASS}
            aria-label="Close custom OFT config dialog"
          >
            <XIcon />
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <div className="rounded-[1.25rem] border border-white/10 bg-black/60 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              JSON payload
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Use the same fields as LayerZero discovery:
              {" "}
              <code>name</code>, <code>endpointVersion</code>, and deployment fields like
              {" "}
              <code>address</code>, <code>localDecimals</code>, <code>innerTokenAddress</code>,
              {" "}
              <code>approvalRequired</code>, and <code>type</code>.
            </p>
            <textarea
              autoFocus
              value={draft.json}
              onChange={(event) => onChange({ json: event.target.value })}
              spellCheck={false}
              className={`${FIELD_CLASS} mt-4 min-h-[24rem] resize-y font-mono text-xs leading-6`}
            />
          </div>

          {error ? (
            <div className="rounded-[1rem] border border-white/18 bg-white/[0.04] px-3 py-2.5 text-sm text-white">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={GHOST_BUTTON_CLASS}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function OftDiscoveryModal({
  sourceChains,
  destinationChains,
  existingConfigs,
  onClose,
  onImport,
}: {
  sourceChains: BridgeChain[];
  destinationChains: BridgeChain[];
  existingConfigs: CustomOftConfig[];
  onClose: () => void;
  onImport: (payload: OftDiscoveryImportPayload) => void;
}) {
  const [query, setQuery] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  const supportedChains = useMemo(
    () => [...sourceChains, ...destinationChains].filter(
      (chain, index, current) =>
        current.findIndex((candidate) => candidate.chainKey === chain.chainKey) === index,
    ),
    [destinationChains, sourceChains],
  );
  const chainByKey = useMemo(
    () => new Map(supportedChains.map((chain) => [chain.chainKey, chain])),
    [supportedChains],
  );
  const executableSourceChainKeys = useMemo(
    () => new Set(sourceChains.map((chain) => chain.chainKey)),
    [sourceChains],
  );
  const chainNames = useMemo(
    () => supportedChains.map((chain) => chain.chainKey).join(","),
    [supportedChains],
  );
  const shouldSearch =
    deferredQuery.length >= 2 || (deferredQuery.length >= 10 && isLikelyOftContractAddress(deferredQuery));
  const oftListQuery = useQuery({
    queryKey: ["bridge", "oft", "list", deferredQuery, chainNames],
    enabled: shouldSearch,
    queryFn: async () => {
      const searchParams = new URLSearchParams();

      if (chainNames) {
        searchParams.set("chainNames", chainNames);
      }

      if (isLikelyOftContractAddress(deferredQuery)) {
        searchParams.set("contractAddresses", deferredQuery);
      } else {
        searchParams.set("symbols", deferredQuery.toUpperCase());
      }

      return fetchJson<LayerZeroOftListResponse>(`/api/bridge/oft-list?${searchParams.toString()}`);
    },
    staleTime: 60 * 1000,
  });
  const entries = useMemo(
    () =>
      oftListQuery.data
        ? normalizeOftDiscoveryEntries(oftListQuery.data, supportedChains)
        : [],
    [oftListQuery.data, supportedChains],
  );
  const existingConfigByIdentity = useMemo(() => {
    const nextConfigByIdentity = new Map<string, CustomOftConfig>();

    for (const config of existingConfigs) {
      nextConfigByIdentity.set(getCustomOftConfigIdentity(config), config);
    }

    return nextConfigByIdentity;
  }, [existingConfigs]);

  function buildImportPayload(entry: OftDiscoveryEntry): OftDiscoveryImportPayload {
    return {
      name: entry.name,
      symbol: entry.symbol,
      endpointVersion: entry.endpointVersion,
      deployments: Object.fromEntries(
        entry.deployments.map((deployment) => [
          deployment.chainKey,
          {
            chainKey: deployment.chainKey,
            oftAddress: deployment.address,
            tokenAddress: deployment.innerTokenAddress ?? undefined,
            decimals: deployment.localDecimals ?? entry.sharedDecimals ?? 18,
            approvalRequired: deployment.approvalRequired,
            type: deployment.type,
          } satisfies CustomOftDeployment,
        ]),
      ),
    };
  }

  function handleImport(entry: OftDiscoveryEntry) {
    const payload = buildImportPayload(entry);

    if (Object.keys(payload.deployments).length < 2) {
      setImportError("LayerZero metadata must include at least two deployments to import a mesh.");
      return;
    }

    onImport(payload);
    setImportError(null);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm">
      <div className="flex h-[min(52rem,calc(100vh-2rem))] w-full max-w-4xl flex-col rounded-[1.6rem] border border-white/12 bg-[var(--overlay-surface)] p-5 shadow-[0_32px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              Discover OFT
            </p>
            <h2 className="mt-2 text-lg font-medium tracking-[-0.03em] text-white">
              Import from LayerZero metadata
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Search by token symbol or OFT contract address, then import the full OFT mesh. You
              will choose source and destination chains later from the saved deployments.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={ICON_BUTTON_CLASS}
            aria-label="Close OFT discovery dialog"
          >
            <XIcon />
          </button>
        </div>

        <div className="mt-5">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search symbol like USDT0 or paste an OFT address"
            className={FIELD_CLASS}
          />
        </div>

        {importError ? (
          <div className="mt-3 rounded-[1rem] border border-white/18 bg-white/[0.04] px-3 py-2.5 text-sm text-white">
            {importError}
          </div>
        ) : null}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {!deferredQuery ? (
            <div className="flex h-full items-center justify-center rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
              Enter a symbol or address to discover LayerZero OFTs.
            </div>
          ) : oftListQuery.isError ? (
            <div className="flex h-full items-center justify-center rounded-[1.25rem] border border-white/18 bg-white/[0.04] px-4 py-3 text-sm text-white">
              {getErrorMessage(oftListQuery.error)}
            </div>
          ) : oftListQuery.isPending ? (
            <div className="flex h-full items-center justify-center rounded-[1.25rem] border border-white/10 bg-black px-4 py-3 text-sm text-[var(--muted)]">
              Discovering OFTs...
            </div>
          ) : entries.length ? (
            <div className="space-y-3">
              {entries.map((entry) => {
                const importPayload = buildImportPayload(entry);
                const duplicateConfig =
                  existingConfigByIdentity.get(getCustomOftConfigIdentity(importPayload)) ?? null;
                const executableSourceCount = entry.deployments.filter((deployment) =>
                  executableSourceChainKeys.has(deployment.chainKey),
                ).length;

                return (
                  <article
                    key={entry.key}
                    className="rounded-[1.25rem] border border-white/10 bg-black/70 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">
                          {entry.name} · {entry.symbol}
                        </p>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {entry.endpointVersion ? `${entry.endpointVersion.toUpperCase()} · ` : ""}
                          {entry.deployments.length} deployment(s)
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleImport(entry)}
                        disabled={entry.deployments.length < 2}
                        className={PRIMARY_BUTTON_CLASS}
                      >
                        {duplicateConfig ? "Update" : "Import"}
                      </button>
                    </div>

                    <div className="mt-3 rounded-[1rem] border border-white/10 bg-white/[0.03] px-3 py-3 text-xs text-[var(--muted)]">
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone="neutral">
                          {Object.keys(importPayload.deployments).length} chains
                        </StatusPill>
                        <StatusPill tone={executableSourceCount ? "success" : "danger"}>
                          {executableSourceCount} executable source
                        </StatusPill>
                        {entry.sharedDecimals !== undefined ? (
                          <StatusPill tone="neutral">
                            shared {entry.sharedDecimals} decimals
                          </StatusPill>
                        ) : null}
                        {entry.endpointVersion ? (
                          <StatusPill tone="neutral">
                            {entry.endpointVersion.toUpperCase()}
                          </StatusPill>
                        ) : null}
                      </div>
                      {duplicateConfig ? (
                        <p className="mt-3 text-white">
                          This mesh already exists as &quot;{duplicateConfig.name}&quot;.
                          Importing will update that saved config.
                        </p>
                      ) : null}
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2">
                      {entry.deployments.map((deployment) => (
                        <div
                          key={`${entry.key}:${deployment.chainKey}`}
                          className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-3 py-2.5"
                        >
                          <p className="font-medium text-white">
                            {chainByKey.get(deployment.chainKey)?.name ?? deployment.chainKey}
                          </p>
                          <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">
                            {deployment.chainKey} ·{" "}
                            {getChainTypeDisplayLabel(
                              chainByKey.get(deployment.chainKey)?.chainType,
                            )}
                          </p>
                          <p className="mt-1 break-all">{deployment.address}</p>
                          <p className="mt-1">
                            decimals {deployment.localDecimals ?? entry.sharedDecimals ?? "--"}
                            {deployment.innerTokenAddress
                              ? ` · inner ${shortenAddress(deployment.innerTokenAddress)}`
                              : ""}
                            {deployment.approvalRequired ? " · approval" : ""}
                            {deployment.type ? ` · ${formatRouteType(deployment.type)}` : ""}
                          </p>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
              No OFT metadata matched this query.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomOftSetupModal({
  configs,
  selectedConfigId,
  onSelectConfig,
  onDiscoverMetadata,
  onManualJson,
  onExport,
  onImport,
  onDelete,
  onClose,
}: {
  configs: CustomOftConfig[];
  selectedConfigId: string;
  onSelectConfig: (id: string) => void;
  onDiscoverMetadata: () => void;
  onManualJson: () => void;
  onExport: () => void;
  onImport: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const selectedConfig = configs.find((c) => c.id === selectedConfigId) ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[1.6rem] border border-white/12 bg-[var(--overlay-surface)] p-5 shadow-[0_32px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              Local Build
            </p>
            <h2 className="mt-2 text-lg font-medium tracking-[-0.03em] text-white">Custom OFT</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Configure OFT meshes for local V2 transaction building. Saved tokens appear in the
              source token list.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={ICON_BUTTON_CLASS}
            aria-label="Close custom OFT setup"
          >
            <XIcon />
          </button>
        </div>

        {configs.length > 0 ? (
          <div className="mt-4 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              Saved configs
            </p>
            <select
              value={selectedConfigId}
              onChange={(event) => onSelectConfig(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Select a config</option>
              {configs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name} · {config.symbol} · {Object.keys(config.deployments).length} chains
                </option>
              ))}
            </select>
            {selectedConfig ? (
              <div className="rounded-[1.25rem] border border-white/10 bg-black/70 p-3 text-sm">
                <p className="font-medium text-white">
                  {selectedConfig.name} · {selectedConfig.symbol}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {Object.keys(selectedConfig.deployments).length} deployments
                  {selectedConfig.endpointVersion
                    ? ` · Endpoint ${selectedConfig.endpointVersion.toUpperCase()}`
                    : ""}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
            No saved configs. Discover or add one below.
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-[1.25rem] border border-white/10 bg-black/70 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              LayerZero Metadata
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Search the LayerZero /list endpoint and import a full OFT mesh.
            </p>
            <button type="button" onClick={onDiscoverMetadata} className={`${GHOST_BUTTON_CLASS} mt-3`}>
              Discover
            </button>
          </div>
          <div className="rounded-[1.25rem] border border-white/10 bg-black/70 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              Manual JSON
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Paste the same JSON structure returned by LayerZero OFT discovery.
            </p>
            <button type="button" onClick={onManualJson} className={`${GHOST_BUTTON_CLASS} mt-3`}>
              Paste JSON
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onExport}
              disabled={!configs.length}
              className={GHOST_BUTTON_CLASS}
            >
              Export JSON
            </button>
            <button type="button" onClick={onImport} className={GHOST_BUTTON_CLASS}>
              Import JSON
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={!selectedConfig}
              className={GHOST_BUTTON_CLASS}
            >
              Delete
            </button>
          </div>
          <button type="button" onClick={onClose} className={PRIMARY_BUTTON_CLASS}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function BridgeApp() {
  const queryClient = useQueryClient();
  const [useApiRoutes, setUseApiRoutes] = useState(false);
  const { wagmiConfig, rpcConfig, updateBridgeEvmChains } = useRpcConfig();
  const [isRpcSettingsOpen, setIsRpcSettingsOpen] = useState(false);
  const [isWalletManagerOpen, setIsWalletManagerOpen] = useState(false);
  const [walletManagerNetwork, setWalletManagerNetwork] = useState<WalletNetwork>("EVM");
  const { address, chainId, isConnected, connector: evmConnector } = useAccount();
  const { connectAsync, connectors, isPending: isConnectPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: isSwitchPending } = useSwitchChain();
  const bridgeWallets = useBridgeWallets();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialUrlParamsRef = useRef({
    srcChain: searchParams.get("srcChain") ?? "",
    dstChain: searchParams.get("dstChain") ?? "",
    srcToken: searchParams.get("srcToken") ?? "",
    dstToken: searchParams.get("dstToken") ?? "",
    applied: false,
  });
  const [urlSelectionReady, setUrlSelectionReady] = useState(false);
  const [srcChainKey, setSrcChainKey] = useState("");
  const [dstChainKey, setDstChainKey] = useState("");
  const [srcTokenAddress, setSrcTokenAddress] = useState("");
  const [dstTokenAddress, setDstTokenAddress] = useState("");
  const [thirdPartyRecipient, setThirdPartyRecipient] = useState<{ chainKey: string; address: string } | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [quotes, setQuotes] = useState<BridgeQuote[]>([]);
  const [quotedRequestKey, setQuotedRequestKey] = useState("");
  const [selectedQuoteRouteKey, setSelectedQuoteRouteKey] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteWarnings, setQuoteWarnings] = useState<string[]>([]);
  const [isQuoting, setIsQuoting] = useState(false);
  const [lastQuoteUpdatedAt, setLastQuoteUpdatedAt] = useState<number | null>(null);
  const [executionState, setExecutionState] = useState<ExecutionState>({
    phase: "idle",
  });
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);
  const executionHistoryRef = useRef<ExecutionHistoryItem[]>([]);
  const [historyStorageError, setHistoryStorageError] = useState(false);
  const [checkingHistoryId, setCheckingHistoryId] = useState<string | null>(null);
  useEffect(() => {
    let saved: ExecutionHistoryItem[] = [];
    try {
      saved = loadExecutionHistory(localStorage, sessionStorage);
    } catch {
      setHistoryStorageError(true);
      // A failed migration write must not hide either copy of existing history.
      try { saved = parseExecutionHistory(localStorage.getItem(EXECUTION_HISTORY_KEY)); } catch { /* Durable storage is inaccessible. */ }
      try { saved = mergeExecutionHistory(saved, parseExecutionHistory(sessionStorage.getItem(EXECUTION_HISTORY_KEY))); } catch { /* No accessible storage. */ }
    }
    executionHistoryRef.current = recoverExecutionHistory(saved);
    setExecutionHistory(executionHistoryRef.current);
    const syncHistory = (event: StorageEvent) => {
      if (event.key !== EXECUTION_HISTORY_KEY || event.storageArea !== localStorage) return;
      executionHistoryRef.current = mergeExecutionHistory(executionHistoryRef.current, parseExecutionHistory(event.newValue));
      setExecutionHistory(executionHistoryRef.current);
    };
    window.addEventListener("storage", syncHistory);
    return () => window.removeEventListener("storage", syncHistory);
  }, []);
  const [executionNotifications, setExecutionNotifications] = useState<
    ExecutionNotification[]
  >([]);
  const [refreshCountdownNow, setRefreshCountdownNow] = useState(() => Date.now());
  const [isCustomOftSetupModalOpen, setIsCustomOftSetupModalOpen] = useState(false);
  const [tokenDisplaySource, setTokenDisplaySource] = useState<TokenDisplaySource>("stargate");
  const [layerZeroApiKey, setLayerZeroApiKey] = useState("");
  const [layerZeroApiKeyDraft, setLayerZeroApiKeyDraft] = useState("");
  const [layerZeroApiKeyError, setLayerZeroApiKeyError] = useState<string | null>(null);
  const [isLayerZeroApiKeyModalOpen, setIsLayerZeroApiKeyModalOpen] = useState(false);
  const [customOftConfigs, setCustomOftConfigs] = useState<CustomOftConfig[]>([]);
  const [selectedCustomOftConfigId, setSelectedCustomOftConfigId] = useState("");
  const [selectedCustomOftSrcChainKey, setSelectedCustomOftSrcChainKey] = useState("");
  const [selectedCustomOftDstChainKey, setSelectedCustomOftDstChainKey] = useState("");
  const [customOftConfigDraft, setCustomOftConfigDraft] =
    useState<CustomOftConfigDraft | null>(null);
  const [customOftConfigError, setCustomOftConfigError] = useState<string | null>(null);
  const [isOftDiscoveryModalOpen, setIsOftDiscoveryModalOpen] = useState(false);
  const [fallbackEvmBalanceValue, setFallbackEvmBalanceValue] = useState<bigint | undefined>();
  const [isFallbackEvmBalanceLoading, setIsFallbackEvmBalanceLoading] = useState(false);
  const [externalWalletBalanceValue, setExternalWalletBalanceValue] = useState<
    bigint | undefined
  >();
  const [isExternalWalletBalanceLoading, setIsExternalWalletBalanceLoading] = useState(false);
  const customOftImportInputRef = useRef<HTMLInputElement | null>(null);
  const skipDstTokenResetRef = useRef<string | null>(null);
  const balanceSwitchAttemptRef = useRef<string | null>(null);
  const notificationTimeoutsRef = useRef(new Map<string, number>());
  const quoteRequestIdRef = useRef(0);
  const isQuotingRef = useRef(false);
  const requestQuoteRef = useRef<
    (mode?: "auto" | "manual" | "refresh") => Promise<void>
  >(async () => undefined);

  const evmWalletConnectors = connectors.filter((connector) =>
    connector.id !== "injected" || (connectors.length === 1 && typeof window !== "undefined" && Boolean(window.ethereum)),
  );

  const chainsQuery = useQuery({
    queryKey: ["bridge", "chains"],
    queryFn: () => fetchJson<{ chains: BridgeChain[]; warnings?: string[] }>("/api/bridge/chains"),
    staleTime: 60 * 60 * 1000,
  });

  const tokensQuery = useQuery({
    queryKey: ["bridge", "tokens", "catalog"],
    queryFn: () => fetchJson<{ tokens: BridgeToken[]; warnings?: string[] }>("/api/bridge/tokens"),
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
      (chain) => chain.chainKey !== "stable",
    );
  }, [chainsQuery.data]);

  // Stable dep string for EVM chain IDs to avoid infinite effect loops
  const evmChainIdsDep = useMemo(
    () =>
      supportedChains
        .filter((c) => c.chainType === "EVM")
        .map((c) => c.chainId)
        .sort((a, b) => a - b)
        .join(","),
    [supportedChains],
  );

  useEffect(() => {
    if (!evmChainIdsDep) return;
    const ids = evmChainIdsDep.split(",").map(Number).filter(Boolean);
    updateBridgeEvmChains(ids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmChainIdsDep]);

  const chainByKey = useMemo(
    () => new Map(supportedChains.map((chain) => [chain.chainKey, chain])),
    [supportedChains],
  );

  const srcChain = useMemo(
    () => chainByKey.get(srcChainKey) ?? null,
    [chainByKey, srcChainKey],
  );

  const dstChain = useMemo(
    () => chainByKey.get(dstChainKey) ?? null,
    [chainByKey, dstChainKey],
  );
  const customOftSourceChains = useMemo(
    () => supportedChains.filter((chain) => isLocalCustomOftSourceChainSupported(chain.chainType)),
    [supportedChains],
  );
  const selectedCustomOftConfig = useMemo(
    () => customOftConfigs.find((config) => config.id === selectedCustomOftConfigId) ?? null,
    [customOftConfigs, selectedCustomOftConfigId],
  );
  const selectedCustomOftDeployments = useMemo(
    () => getSortedCustomOftDeployments(selectedCustomOftConfig),
    [selectedCustomOftConfig],
  );
  const customOftRuntimeSourceChains = useMemo(
    () =>
      selectedCustomOftDeployments.flatMap((deployment) => {
        const chain = chainByKey.get(deployment.chainKey);

        return chain &&
          isLocalCustomOftSourceChainSupported(chain.chainType)
          ? [chain]
          : [];
      }),
    [chainByKey, selectedCustomOftDeployments],
  );
  const customOftRuntimeDestinationChains = useMemo(
    () =>
      selectedCustomOftDeployments.flatMap((deployment) => {
        if (deployment.chainKey === selectedCustomOftSrcChainKey) {
          return [];
        }

        const chain = chainByKey.get(deployment.chainKey);

        return chain &&
          isLocalCustomOftDestinationChainSupported(chain.chainType, chain.chainKey)
          ? [chain]
          : [];
      }),
    [chainByKey, selectedCustomOftDeployments, selectedCustomOftSrcChainKey],
  );
  const customOftSrcChain = useMemo(
    () => chainByKey.get(selectedCustomOftSrcChainKey) ?? null,
    [chainByKey, selectedCustomOftSrcChainKey],
  );
  const customOftDstChain = useMemo(
    () => chainByKey.get(selectedCustomOftDstChainKey) ?? null,
    [chainByKey, selectedCustomOftDstChainKey],
  );
  const selectedCustomOftSourceDeployment = useMemo(
    () => selectedCustomOftConfig?.deployments[selectedCustomOftSrcChainKey] ?? null,
    [selectedCustomOftConfig, selectedCustomOftSrcChainKey],
  );
  const selectedCustomOftDestinationDeployment = useMemo(
    () => selectedCustomOftConfig?.deployments[selectedCustomOftDstChainKey] ?? null,
    [selectedCustomOftConfig, selectedCustomOftDstChainKey],
  );
  const customOftSourceToken = useMemo<BridgeToken | null>(() => {
    if (!selectedCustomOftConfig || !customOftSrcChain || !selectedCustomOftSourceDeployment) {
      return null;
    }

    return {
      chainKey: customOftSrcChain.chainKey,
      address:
        selectedCustomOftSourceDeployment.tokenAddress ?? selectedCustomOftSourceDeployment.oftAddress,
      decimals: selectedCustomOftSourceDeployment.decimals,
      symbol: selectedCustomOftConfig.symbol,
      name: selectedCustomOftConfig.name,
    };
  }, [customOftSrcChain, selectedCustomOftConfig, selectedCustomOftSourceDeployment]);
  const customOftDestinationToken = useMemo<BridgeToken | null>(() => {
    if (!selectedCustomOftConfig || !customOftDstChain || !selectedCustomOftDestinationDeployment) {
      return null;
    }

    return {
      chainKey: customOftDstChain.chainKey,
      address:
        selectedCustomOftDestinationDeployment.tokenAddress ??
        selectedCustomOftDestinationDeployment.oftAddress,
      decimals: selectedCustomOftDestinationDeployment.decimals,
      symbol: selectedCustomOftConfig.symbol,
      name: selectedCustomOftConfig.name,
    };
  }, [customOftDstChain, selectedCustomOftConfig, selectedCustomOftDestinationDeployment]);
  const isCustomOftSource = useMemo(() => {
    if (!selectedCustomOftConfigId || !selectedCustomOftSrcChainKey) return false;
    const config = customOftConfigs.find((c) => c.id === selectedCustomOftConfigId);
    if (!config) return false;
    const deployment = config.deployments[selectedCustomOftSrcChainKey];
    if (!deployment) return false;
    const expectedAddress = (deployment.tokenAddress ?? deployment.oftAddress).toLowerCase();
    return (
      srcTokenAddress.toLowerCase() === expectedAddress &&
      srcChainKey === selectedCustomOftSrcChainKey
    );
  }, [
    customOftConfigs,
    selectedCustomOftConfigId,
    selectedCustomOftSrcChainKey,
    srcTokenAddress,
    srcChainKey,
  ]);
  const activeSrcChain = isCustomOftSource ? customOftSrcChain : srcChain;
  const activeDstChain = isCustomOftSource ? customOftDstChain : dstChain;

  const allSupportedTokens = useMemo(() => {
    return (tokensQuery.data?.tokens ?? [])
      .filter((token) => chainByKey.has(token.chainKey))
      .toSorted(compareBridgeTokens);
  }, [chainByKey, tokensQuery.data]);

  const srcTokens = useMemo(() => {
    if (!srcChainKey) {
      return allSupportedTokens;
    }

    return allSupportedTokens.filter((token) => token.chainKey === srcChainKey);
  }, [allSupportedTokens, srcChainKey]);

  const routeTokensQuery = useQuery({
    queryKey: ["bridge", "tokens", "routes", srcChainKey, srcTokenAddress],
    enabled: Boolean(srcChainKey && srcTokenAddress),
    queryFn: () =>
      fetchJson<{ tokens: BridgeToken[]; warnings?: string[] }>(
        `/api/bridge/tokens?transferrableFromChainKey=${encodeURIComponent(srcChainKey)}&transferrableFromTokenAddress=${encodeURIComponent(srcTokenAddress)}`,
      ),
    staleTime: 5 * 60 * 1000,
  });

  const selectableDestinationChains = useMemo(() => {
    if (!routeTokensQuery.data) {
      return supportedChains.filter((chain) => !srcChainKey || chain.chainKey !== srcChainKey);
    }

    const availableKeys = new Set(
      routeTokensQuery.data.tokens.map((token) => token.chainKey),
    );

    return supportedChains.filter(
      (chain) =>
        availableKeys.has(chain.chainKey) &&
        (!srcChainKey || chain.chainKey !== srcChainKey),
    );
  }, [routeTokensQuery.data, srcChainKey, supportedChains]);

  const destinationTokenCatalog = useMemo(() => {
    const tokens = routeTokensQuery.data ? routeTokensQuery.data.tokens : allSupportedTokens;

    return tokens
      .filter(
        (token) =>
          chainByKey.has(token.chainKey) &&
          (!srcChainKey || token.chainKey !== srcChainKey),
      )
      .toSorted(compareBridgeTokens);
  }, [allSupportedTokens, chainByKey, routeTokensQuery.data, srcChainKey]);

  const destinationTokens = useMemo(() => {
    if (!dstChainKey) {
      return destinationTokenCatalog;
    }

    return destinationTokenCatalog.filter((token) => token.chainKey === dstChainKey);
  }, [destinationTokenCatalog, dstChainKey]);

  const selectedSrcToken = useMemo(
    () =>
      srcTokens.find(
        (token) => isMatchingSelectedToken(token, srcChainKey, srcTokenAddress),
      ) ?? null,
    [srcChainKey, srcTokenAddress, srcTokens],
  );

  const selectedDstToken = useMemo(
    () =>
      destinationTokens.find(
        (token) => isMatchingSelectedToken(token, dstChainKey, dstTokenAddress),
      ) ?? null,
    [destinationTokens, dstChainKey, dstTokenAddress],
  );
  const selectedSrcTokenPresentation = useMemo(
    () => getTokenPresentation(selectedSrcToken, tokenDisplaySource, stargateTokenDetailsById),
    [selectedSrcToken, stargateTokenDetailsById, tokenDisplaySource],
  );
  const selectedDstTokenPresentation = useMemo(
    () => getTokenPresentation(selectedDstToken, tokenDisplaySource, stargateTokenDetailsById),
    [selectedDstToken, stargateTokenDetailsById, tokenDisplaySource],
  );
  const customOftSourceTokenPresentation = useMemo(
    () => getTokenPresentation(customOftSourceToken, "layerzero", stargateTokenDetailsById),
    [customOftSourceToken, stargateTokenDetailsById],
  );
  const customOftDestinationTokenPresentation = useMemo(
    () => getTokenPresentation(customOftDestinationToken, "layerzero", stargateTokenDetailsById),
    [customOftDestinationToken, stargateTokenDetailsById],
  );
  const selectedSrcTokenSymbol = selectedSrcTokenPresentation?.symbol ?? "--";
  const selectedDstTokenSymbol = selectedDstTokenPresentation?.symbol ?? "--";
  const selectedSrcTokenIconUrl =
    selectedSrcTokenPresentation?.iconUrl ?? getStargateTokenIconUrl(selectedSrcTokenSymbol);
  const selectedDstTokenIconUrl =
    selectedDstTokenPresentation?.iconUrl ?? getStargateTokenIconUrl(selectedDstTokenSymbol);
  const customOftSourceTokenSymbol = customOftSourceTokenPresentation?.symbol ?? "--";
  const customOftDestinationTokenSymbol = customOftDestinationTokenPresentation?.symbol ?? "--";
  const customOftSourceTokenIconUrl =
    customOftSourceTokenPresentation?.iconUrl ??
    getStargateTokenIconUrl(customOftSourceTokenSymbol);
  const customOftDestinationTokenIconUrl =
    customOftDestinationTokenPresentation?.iconUrl ??
    getStargateTokenIconUrl(customOftDestinationTokenSymbol);
  const activeBalanceToken = isCustomOftSource ? customOftSourceToken : selectedSrcToken;
  const activeBalanceTokenSymbol =
    isCustomOftSource ? customOftSourceTokenSymbol : selectedSrcTokenSymbol;
  const hasLayerZeroApiKey = Boolean(layerZeroApiKey.trim());
  const bridgeApiProvider =
    tokenDisplaySource === "layerzero"
      ? (hasLayerZeroApiKey ? "layerzero" : "stargate-v2")
      : "stargate";
  const isLayerZeroFallback = tokenDisplaySource === "layerzero" && !hasLayerZeroApiKey;
  const sourceChainType = activeSrcChain?.chainType;
  const destinationChainType = activeDstChain?.chainType;
  const sourceChainUsesEvmWallet = sourceChainType === "EVM";
  const sourceChainHasConfiguredWallet =
    sourceChainType === "EVM" &&
    Boolean(activeSrcChain && activeSrcChain.chainKey in walletChainByKey);
  const activeExternalWalletSession = sourceChainType
    ? bridgeWallets.walletSessionsByChainType[sourceChainType] ?? null
    : null;
  const destinationExternalWalletSession = destinationChainType
    ? bridgeWallets.walletSessionsByChainType[destinationChainType] ?? null
    : null;
  const sourceWalletAddress = sourceChainUsesEvmWallet
    ? (address ?? "")
    : (activeExternalWalletSession?.address ?? "");
  const preferredDestinationWalletAddress =
    destinationChainType === "EVM"
      ? (isConnected ? address ?? "" : "")
      : (destinationExternalWalletSession?.address ?? "");
  const sourceWalletConnected = sourceChainUsesEvmWallet
    ? Boolean(address && isConnected)
    : Boolean(activeExternalWalletSession?.address);
  const destinationWalletLabel =
    destinationChainType === "EVM"
      ? "EVM Wallet"
      : destinationExternalWalletSession?.label ?? getChainTypeDisplayLabel(destinationChainType);
  const destinationAddressPlaceholder = getDestinationAddressPlaceholder(destinationChainType);
  const destinationAddressValidationCopy = getAddressValidationCopy(destinationChainType);
  const canExecuteSelectedSourceChain = canExecuteSourceChainType(sourceChainType);
  const walletConnectButtonCopy = getWalletConnectLabel(sourceChainType);
  const hasPreferredDestinationWalletAddress = Boolean(
    preferredDestinationWalletAddress &&
      validateAddressForChainType(destinationChainType, preferredDestinationWalletAddress),
  );

  const useThirdPartyRecipient = Boolean(activeDstChain && thirdPartyRecipient?.chainKey === activeDstChain.chainKey);
  const destinationAddress = useThirdPartyRecipient
    ? thirdPartyRecipient!.address
    : hasPreferredDestinationWalletAddress ? preferredDestinationWalletAddress : "";
  const destinationWalletNetwork = WALLET_NETWORKS.find((network) => network.type === destinationChainType)?.type;
  const destinationRecipientCopy = !useThirdPartyRecipient && !hasPreferredDestinationWalletAddress
    ? `Connect a ${getChainTypeDisplayLabel(destinationChainType)} destination wallet or explicitly choose a third-party address.`
    : destinationAddressValidationCopy;

  const srcChainItems = useMemo<InlineOptionItem[]>(
    () =>
      supportedChains.map((chain) => ({
        key: chain.chainKey,
        badgeText: chain.shortName,
        iconUrl: getStargateChainIconUrl(chain.chainKey),
        title: chain.name,
        subtitle: `${chain.shortName} · ${getChainTypeDisplayLabel(chain.chainType)}`,
        meta: chain.nativeCurrency.symbol,
        searchTerms: [
          chain.chainKey,
          chain.name,
          chain.shortName,
          chain.nativeCurrency.symbol,
          chain.chainType,
        ],
        selected: chain.chainKey === srcChainKey,
        onSelect: () => setSrcChainKey((current) => (current === chain.chainKey ? "" : chain.chainKey)),
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
        const chain = chainByKey.get(token.chainKey);

        return {
          key: `${token.chainKey}:${token.address}`,
          badgeText: displaySymbol,
          iconUrl: presentation?.iconUrl,
          iconBadgeLabel: chain?.shortName ?? token.chainKey,
          iconBadgeUrl: getStargateChainIconUrl(token.chainKey),
          title: displaySymbol,
          subtitle: buildTokenOptionSubtitle(presentation?.name ?? token.name, chain),
          meta: buildTokenOptionMeta(chain, presentation?.priceUsd),
          searchTerms: [
            displaySymbol,
            token.symbol,
            token.name,
            token.address,
            token.chainKey,
            chain?.name,
            chain?.shortName,
          ].filter(Boolean) as string[],
          selected: isMatchingSelectedToken(token, srcChainKey, srcTokenAddress),
          onSelect: () => {
            setSrcChainKey(token.chainKey);
            setSrcTokenAddress(token.address);
          },
        };
      }),
    [
      chainByKey,
      srcChainKey,
      srcTokenAddress,
      srcTokens,
      stargateTokenDetailsById,
      tokenDisplaySource,
    ],
  );

  const dstChainItems = useMemo<InlineOptionItem[]>(
    () =>
      selectableDestinationChains.map((chain) => ({
        key: chain.chainKey,
        badgeText: chain.shortName,
        iconUrl: getStargateChainIconUrl(chain.chainKey),
        title: chain.name,
        subtitle: `${chain.shortName} · ${getChainTypeDisplayLabel(chain.chainType)}`,
        meta: chain.nativeCurrency.symbol,
        searchTerms: [
          chain.chainKey,
          chain.name,
          chain.shortName,
          chain.nativeCurrency.symbol,
          chain.chainType,
        ],
        selected: chain.chainKey === dstChainKey,
        onSelect: () => setDstChainKey((current) => (current === chain.chainKey ? "" : chain.chainKey)),
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
        const chain = chainByKey.get(token.chainKey);

        return {
          key: `${token.chainKey}:${token.address}`,
          badgeText: displaySymbol,
          iconUrl: presentation?.iconUrl,
          iconBadgeLabel: chain?.shortName ?? token.chainKey,
          iconBadgeUrl: getStargateChainIconUrl(token.chainKey),
          title: displaySymbol,
          subtitle: buildTokenOptionSubtitle(presentation?.name ?? token.name, chain),
          meta: buildTokenOptionMeta(chain, presentation?.priceUsd),
          searchTerms: [
            displaySymbol,
            token.symbol,
            token.name,
            token.address,
            token.chainKey,
            chain?.name,
            chain?.shortName,
          ].filter(Boolean) as string[],
          selected: isMatchingSelectedToken(token, dstChainKey, dstTokenAddress),
          onSelect: () => {
            setDstChainKey(token.chainKey);
            setDstTokenAddress(token.address);
          },
        };
      }),
    [
      chainByKey,
      destinationTokens,
      dstChainKey,
      dstTokenAddress,
      stargateTokenDetailsById,
      tokenDisplaySource,
    ],
  );

  const customOftSrcTokenItems = useMemo<InlineOptionItem[]>(
    () =>
      customOftConfigs.flatMap((config) => {
        const candidateDeployments = srcChainKey
          ? (() => {
              const deployment = config.deployments[srcChainKey];
              return deployment ? [{ ...deployment, chainKey: srcChainKey }] : [];
            })()
          : getSortedCustomOftDeployments(config);

        return candidateDeployments.flatMap((deployment) => {
          const chain = chainByKey.get(deployment.chainKey);

          if (!chain || !isLocalCustomOftSourceChainSupported(chain.chainType)) {
            return [];
          }

          const address = deployment.tokenAddress ?? deployment.oftAddress;
          const symbol = config.symbol;
          const isSelected =
            selectedCustomOftConfigId === config.id &&
            selectedCustomOftSrcChainKey === deployment.chainKey &&
            isMatchingSelectedToken(
              { chainKey: deployment.chainKey, address },
              srcChainKey,
              srcTokenAddress,
            );

          return [
            {
              key: `custom-oft:${config.id}:${deployment.chainKey}`,
              badgeText: symbol,
              iconUrl: getStargateTokenIconUrl(symbol),
              iconBadgeLabel: chain.shortName,
              iconBadgeUrl: getStargateChainIconUrl(deployment.chainKey),
              title: symbol,
              subtitle: buildTokenOptionSubtitle(config.name, chain),
              meta: "OFT",
              searchTerms: [
                symbol,
                config.name,
                address,
                deployment.chainKey,
                chain.name,
                chain.shortName,
              ],
              selected: isSelected,
              onSelect: () => {
                setSrcChainKey(deployment.chainKey);
                setSrcTokenAddress(address);
                setSelectedCustomOftConfigId(config.id);
                setSelectedCustomOftSrcChainKey(deployment.chainKey);
                setSelectedCustomOftDstChainKey("");
                setDstChainKey("");
              },
            },
          ];
        });
      }),
    [
      chainByKey,
      customOftConfigs,
      srcChainKey,
      selectedCustomOftConfigId,
      selectedCustomOftSrcChainKey,
      srcTokenAddress,
    ],
  );

  const customOftDstChainItems = useMemo<InlineOptionItem[]>(
    () =>
      customOftRuntimeDestinationChains.map((chain) => ({
        key: chain.chainKey,
        badgeText: chain.shortName,
        iconUrl: getStargateChainIconUrl(chain.chainKey),
        title: chain.name,
        subtitle: `${chain.shortName} · ${getChainTypeDisplayLabel(chain.chainType)}`,
        meta: chain.nativeCurrency.symbol,
        searchTerms: [
          chain.chainKey,
          chain.name,
          chain.shortName,
          chain.nativeCurrency.symbol,
          chain.chainType,
        ],
        selected: chain.chainKey === dstChainKey,
        onSelect: () => {
          const nextChainKey = dstChainKey === chain.chainKey ? "" : chain.chainKey;
          setDstChainKey(nextChainKey);
          setSelectedCustomOftDstChainKey(nextChainKey);
        },
      })),
    [customOftRuntimeDestinationChains, dstChainKey],
  );

  const customOftDstTokenItems = useMemo<InlineOptionItem[]>(
    () => {
      if (!customOftDestinationToken) return [];
      const symbol = customOftDestinationTokenSymbol;
      return [
        {
          key: `custom-oft-dst:${selectedCustomOftConfigId}:${dstChainKey}`,
          badgeText: symbol,
          iconUrl: customOftDestinationTokenIconUrl,
          iconBadgeLabel: customOftDstChain?.shortName ?? dstChainKey,
          iconBadgeUrl: customOftDstChain ? getStargateChainIconUrl(customOftDstChain.chainKey) : undefined,
          title: symbol,
          subtitle: buildTokenOptionSubtitle(selectedCustomOftConfig?.name ?? symbol, customOftDstChain),
          selected: true,
          onSelect: () => {},
        },
      ];
    },
    [
      customOftDestinationToken,
      customOftDestinationTokenSymbol,
      customOftDestinationTokenIconUrl,
      customOftDstChain,
      selectedCustomOftConfigId,
      dstChainKey,
      selectedCustomOftConfig,
    ],
  );

  const quoteRequestState = useMemo(() => {
    if (!sourceWalletAddress) {
      return {
        ready: false,
        reason: `${getWalletConnectLabel(sourceChainType)} before requesting a quote.`,
      } as const;
    }

    if (!srcChain || !dstChain || srcChain.chainKey === dstChain.chainKey) {
      return {
        ready: false,
        reason: "Choose two different chains.",
      } as const;
    }

    if (!selectedSrcToken || !selectedDstToken) {
      return {
        ready: false,
        reason: "Select both source and destination tokens.",
      } as const;
    }

    if (!destinationAddress || !validateAddressForChainType(destinationChainType, destinationAddress)) {
      return {
        ready: false,
        reason: destinationRecipientCopy,
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
          provider: bridgeApiProvider,
          srcChainKey: srcChain.chainKey,
          dstChainKey: dstChain.chainKey,
          srcTokenAddress: selectedSrcToken.address,
          dstTokenAddress: selectedDstToken.address,
          srcWalletAddress: sourceWalletAddress,
          dstWalletAddress: destinationAddress,
          amount: parsedAmount.toString(),
          options: {
            amountType: "EXACT_SRC_AMOUNT",
            feeTolerance: {
              type: "PERCENT",
              amount: 0.5,
            },
            dstNativeDropAmount: "0",
          },
        },
      } as const;
    } catch {
      return {
        ready: false,
        reason: "Enter a valid amount.",
      } as const;
    }
  }, [
    amountInput,
    bridgeApiProvider,
    destinationRecipientCopy,
    destinationChainType,
    destinationAddress,
    dstChain,
    selectedDstToken,
    selectedSrcToken,
    sourceChainType,
    sourceWalletAddress,
    srcChain,
  ]);

  const quoteRequestKey = quoteRequestState.ready
    ? JSON.stringify([useApiRoutes, quoteRequestState.payload])
    : "";

  const quote = useMemo(() => {
    if (!quotes.length || quotedRequestKey !== quoteRequestKey) {
      return null;
    }

    if (!selectedQuoteRouteKey) {
      return quotes[0];
    }

    return (
      quotes.find((candidate) => getQuoteRouteKey(candidate) === selectedQuoteRouteKey) ??
      quotes[0]
    );
  }, [quotes, selectedQuoteRouteKey, quotedRequestKey, quoteRequestKey]);

  const availableQuoteCount = quotes.length;
  const bestQuoteRouteKey = quotes[0] && quotes.every(candidate => Number.isFinite(getQuoteFeeUsdValue(candidate))) ? getQuoteRouteKey(quotes[0]) : null;

  const balanceEnabled = Boolean(
    sourceChainUsesEvmWallet &&
      address &&
      activeSrcChain &&
      activeBalanceToken &&
      chainId === activeSrcChain.chainId &&
      isConnected,
  );
  const externalBalanceEnabled = Boolean(
    !sourceChainUsesEvmWallet &&
      sourceChainType &&
      sourceWalletAddress &&
      activeBalanceToken &&
      sourceWalletConnected,
  );
  const supportedSrcChainId = sourceChainHasConfiguredWallet
    ? (activeSrcChain?.chainId as SupportedChainId | undefined)
    : undefined;

  const nativeBalanceQuery = useBalance({
    address: address as Address | undefined,
    chainId: supportedSrcChainId,
    query: {
      enabled:
        balanceEnabled &&
        sourceChainHasConfiguredWallet &&
        Boolean(activeBalanceToken && isNativeToken(activeBalanceToken.address)),
      staleTime: 15 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const erc20BalanceQuery = useReadContract({
    address:
      activeBalanceToken && !isNativeToken(activeBalanceToken.address)
        ? (activeBalanceToken.address as Address)
        : undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address as Address] : undefined,
    chainId: supportedSrcChainId,
    query: {
      enabled:
        balanceEnabled &&
        sourceChainHasConfiguredWallet &&
        Boolean(activeBalanceToken && !isNativeToken(activeBalanceToken.address)),
      staleTime: 15 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  useEffect(() => {
    if (
      !balanceEnabled ||
      sourceChainHasConfiguredWallet ||
      !activeBalanceToken ||
      !address
    ) {
      setFallbackEvmBalanceValue(undefined);
      setIsFallbackEvmBalanceLoading(false);
      return;
    }

    let isCancelled = false;
    setIsFallbackEvmBalanceLoading(true);

    void getConnectorEvmProvider(evmConnector).then((provider) => fetchInjectedEvmBalance({
      provider,
      account: address as Address,
      tokenAddress: isNativeToken(activeBalanceToken.address)
        ? null
        : (activeBalanceToken.address as Address),
    }))
      .then((value) => {
        if (isCancelled) {
          return;
        }

        setFallbackEvmBalanceValue(value);
      })
      .catch(() => {
        if (isCancelled) {
          return;
        }

        setFallbackEvmBalanceValue(undefined);
      })
      .finally(() => {
        if (isCancelled) {
          return;
        }

        setIsFallbackEvmBalanceLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeBalanceToken, address, balanceEnabled, sourceChainHasConfiguredWallet, evmConnector]);

  useEffect(() => {
    if (
      !externalBalanceEnabled ||
      !sourceChainType ||
      !sourceWalletAddress ||
      !activeBalanceToken
    ) {
      setExternalWalletBalanceValue(undefined);
      setIsExternalWalletBalanceLoading(false);
      return;
    }

    let isCancelled = false;
    setIsExternalWalletBalanceLoading(true);

    void fetchExternalWalletBalance({
      chainType: sourceChainType,
      account: sourceWalletAddress,
      tokenAddress: activeBalanceToken.address,
    })
      .then((value) => {
        if (isCancelled) {
          return;
        }

        setExternalWalletBalanceValue(value);
      })
      .catch(() => {
        if (isCancelled) {
          return;
        }

        setExternalWalletBalanceValue(undefined);
      })
      .finally(() => {
        if (isCancelled) {
          return;
        }

        setIsExternalWalletBalanceLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeBalanceToken, externalBalanceEnabled, sourceChainType, sourceWalletAddress]);

  const selectedEvmBalanceValue =
    sourceChainHasConfiguredWallet
      ? activeBalanceToken && isNativeToken(activeBalanceToken.address)
        ? nativeBalanceQuery.data?.value
        : erc20BalanceQuery.data
      : fallbackEvmBalanceValue;

  const isEvmBalanceLoading = sourceChainHasConfiguredWallet
    ? activeBalanceToken && isNativeToken(activeBalanceToken.address)
      ? nativeBalanceQuery.isPending
      : erc20BalanceQuery.isPending
    : isFallbackEvmBalanceLoading;

  const selectedBalanceValue = sourceChainUsesEvmWallet
    ? selectedEvmBalanceValue
    : externalWalletBalanceValue;

  const isBalanceLoading = sourceChainUsesEvmWallet
    ? isEvmBalanceLoading
    : isExternalWalletBalanceLoading;

  const balanceCopy = useMemo(() => {
    if (!activeBalanceToken) {
      return "Select a token";
    }

    if (!sourceWalletConnected) {
      return walletConnectButtonCopy;
    }

    if (sourceChainUsesEvmWallet && activeSrcChain && chainId !== activeSrcChain.chainId) {
      return isSwitchPending ? "Switching..." : "Auto switching...";
    }

    if (isBalanceLoading) {
      return "Loading...";
    }

    if (selectedBalanceValue !== undefined) {
      return `${Number(
        formatUnits(selectedBalanceValue, activeBalanceToken.decimals),
      ).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      })} ${activeBalanceTokenSymbol}`;
    }

    return "Unavailable";
  }, [
    activeBalanceToken,
    activeBalanceTokenSymbol,
    activeSrcChain,
    chainId,
    isBalanceLoading,
    isSwitchPending,
    selectedBalanceValue,
    sourceChainUsesEvmWallet,
    sourceWalletConnected,
    walletConnectButtonCopy,
  ]);

  async function switchEvmChain(chain: BridgeChain) {
    if (chain.chainType !== "EVM") {
      throw new Error("Expected an EVM chain.");
    }

    if (chain.chainKey in walletChainByKey) {
      await switchChainAsync({ chainId: chain.chainId as SupportedChainId });
      return;
    }

    await switchInjectedEvmChain(chain.chainId, chain.shortName, await getConnectorEvmProvider(evmConnector));
  }

  async function readEvmContractForChain<T>({
    abi,
    address,
    args,
    chain,
    functionName,
  }: {
    abi: Abi;
    address: Address;
    args?: readonly unknown[];
    chain: BridgeChain;
    functionName: string;
  }) {
    if (chain.chainType !== "EVM") {
      throw new Error("Expected an EVM chain.");
    }

    if (wagmiConfig.chains.some((configured) => configured.id === chain.chainId)) {
      try {
        return (await readContract(wagmiConfig, {
          address,
          abi,
          functionName,
          args,
          chainId: chain.chainId as SupportedChainId,
        })) as T;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (/does not exist|not available|request failed|failed to fetch|econnrefused|timed? ?out/i.test(msg))
          throw new Error(`Failed to read on-chain data on ${chain.shortName ?? chain.chainKey}. Check your RPC settings.`);
        throw error;
      }
    }

    throw new Error(`No verified RPC configured for ${chain.shortName}.`);

  }

  async function sendEvmTransactionForChain(
    chain: BridgeChain,
    transaction: {
      data?: Hex;
      from: Address;
      gas?: bigint;
      to: Address;
      value?: bigint;
    },
  ) {
    if (chain.chainType !== "EVM") {
      throw new Error("Expected an EVM chain.");
    }

    if (wagmiConfig.chains.some((configured) => configured.id === chain.chainId)) {
      const account = getAccount(wagmiConfig);
      if (account.address?.toLowerCase() !== transaction.from.toLowerCase() || account.chainId !== chain.chainId)
        throw new Error("Wallet account or network changed. Review the transfer again.");
      const client = getPublicClient(wagmiConfig, { chainId: chain.chainId });
      if (!client) throw new Error("No RPC configured for the source chain.");
      await client.call({ account: transaction.from, to: transaction.to, data: transaction.data, value: transaction.value ?? BigInt(0) });
      assertCurrentExecutionContext();
      const afterSimulation = getAccount(wagmiConfig);
      if (afterSimulation.address?.toLowerCase() !== transaction.from.toLowerCase() || afterSimulation.chainId !== chain.chainId)
        throw new Error("Wallet account or network changed during simulation. Review the transfer again.");
      return sendTransaction(wagmiConfig, {
        account: transaction.from,
        chainId: chain.chainId as SupportedChainId,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value ?? BigInt(0),
        gas: transaction.gas,
      });
    }

    throw new Error(`No verified RPC configured for ${chain.shortName}.`);
  }

  async function waitForEvmTransaction(chain: BridgeChain, hash: string) {
    if (chain.chainType !== "EVM") {
      throw new Error("Expected an EVM chain.");
    }

    if (wagmiConfig.chains.some((configured) => configured.id === chain.chainId)) {
      const receipt = await waitForTransactionReceipt(wagmiConfig, {
        chainId: chain.chainId as SupportedChainId,
        hash: hash as Hex,
        onReplaced: ({ reason }) => {
          if (reason !== "repriced") throw new Error("Transaction was cancelled or replaced. Check its hash before retrying.");
        },
      });
      assertSuccessfulEvmReceipt(receipt);
      return receipt.transactionHash;
    }

    throw new Error(`No verified RPC configured for ${chain.shortName}.`);
  }

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

    setExecutionNotifications((current) => [...current.filter((item) => item.title !== title || item.message !== message), nextNotification].slice(-2));

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

  function commitExecutionHistory(update: (items: ExecutionHistoryItem[]) => ExecutionHistoryItem[]) {
    let current = executionHistoryRef.current;
    try { current = mergeExecutionHistory(parseExecutionHistory(localStorage.getItem(EXECUTION_HISTORY_KEY)), current); } catch { /* Retain in-memory history. */ }
    const next = mergeExecutionHistory(update(current));
    // Persist synchronously at each submission/status update, before a reload can interrupt React effects.
    try {
      localStorage.setItem(EXECUTION_HISTORY_KEY, JSON.stringify(next));
      setHistoryStorageError(false);
    } catch { setHistoryStorageError(true); }
    executionHistoryRef.current = next;
    setExecutionHistory(next);
  }

  function prependExecutionHistoryItem(item: ExecutionHistoryItem) {
    commitExecutionHistory((current) => [item, ...current]);
  }

  function updateExecutionHistoryItem(
    historyId: string,
    patch: Partial<Omit<ExecutionHistoryItem, "id" | "quoteId" | "createdAt">>,
  ) {
    commitExecutionHistory((current) => current.map((item) => item.id === historyId
      ? { ...item, ...patch, updatedAt: Math.max(Date.now(), item.updatedAt + 1) }
      : item));
  }

  async function recheckSolanaHistory(item: ExecutionHistoryItem) {
    if (!item.solanaSubmission || checkingHistoryId) return;
    setCheckingHistoryId(item.id);
    try {
      const result = await checkSolanaSubmission(item.solanaSubmission);
      if (item.phase === "success" && result.outcome === "pending") return;
      const phase = result.outcome === "confirmed" ? "success" : result.outcome === "pending" ? "pending" : "error";
      const transferStatus = result.outcome === "confirmed" ? "SOURCE_CONFIRMED" : result.outcome === "pending" ? "CONFIRMATION_PENDING" : result.outcome === "expired" ? "EXPIRED" : "FAILED";
      const error = result.outcome === "confirmed" ? undefined : new SolanaConfirmationError(result.outcome, item.solanaSubmission, result.detail).message;
      updateExecutionHistoryItem(item.id, { phase, transferStatus, error, currentStep: result.outcome === "confirmed" ? "Source confirmed. Track destination settlement on LayerZeroScan." : undefined });
      setExecutionState((current) => current.activeHistoryId === item.id ? { ...current, phase, transferStatus, error } : current);
    } finally { setCheckingHistoryId(null); }
  }

  function applyCcipStatus(historyId: string, status: BridgeStatusResponse) {
    const existing = executionHistoryRef.current.find(item => item.id === historyId);
    if (existing?.phase === "success" && status.status !== "COMPLETED") return;
    if (existing?.phase === "error" && ["FAILED", "CANCELLED"].includes(existing.transferStatus ?? "") && status.status !== "COMPLETED") return;
    const phase = status.status === "COMPLETED" ? "success" : status.status === "FAILED" || status.status === "CANCELLED" ? "error" : "pending";
    const patch = { phase, transferStatus: status.status, explorerUrl: status.explorerUrl ?? existing?.explorerUrl, error: status.error,
      currentStep: status.substatus ?? (phase === "success" ? "CCIP transfer completed." : undefined) } as const;
    updateExecutionHistoryItem(historyId, patch);
    setExecutionState(current => current.activeHistoryId === historyId ? { ...current, ...patch } : current);
  }

  async function recheckCcipHistory(item: ExecutionHistoryItem) {
    if (!item.ccipSubmission || checkingHistoryId) return;
    setCheckingHistoryId(item.id);
    try {
      if (!item.ccipSubmission.confirmed) {
        const client = getPublicClient(wagmiConfig, { chainId: item.ccipSubmission.chainId });
        if (!client) throw new Error("The source network RPC is unavailable. Check RPC settings and retry status.");
        const receipt = await client.getTransactionReceipt({ hash: item.ccipSubmission.hash as Hex });
        if (receipt.status !== "success") {
          applyCcipStatus(item.id, { status: "FAILED", error: "The source transaction reverted. No CCIP transfer was sent." });
          return;
        }
        updateExecutionHistoryItem(item.id, { ccipSubmission: { ...item.ccipSubmission, confirmed: true } });
      }
      const params = new URLSearchParams({ provider: "ccip", txHash: item.ccipSubmission.hash });
      const status = await fetchJson<BridgeStatusResponse>(`/api/bridge/status/${encodeURIComponent(item.quoteId)}?${params}`);
      applyCcipStatus(item.id, status);
    } catch {
      // A missing receipt, timeout or indexer outage is not evidence of failure.
      updateExecutionHistoryItem(item.id, { phase: "pending", error: "Confirmation or tracking is not available yet. Check status again before sending another transfer." });
    } finally { setCheckingHistoryId(null); }
  }

  function openLayerZeroApiKeyModal() {
    setLayerZeroApiKeyDraft(layerZeroApiKey);
    setLayerZeroApiKeyError(null);
    setIsLayerZeroApiKeyModalOpen(true);
  }

  function closeLayerZeroApiKeyModal() {
    setLayerZeroApiKeyDraft(layerZeroApiKey);
    setLayerZeroApiKeyError(null);
    setIsLayerZeroApiKeyModalOpen(false);
  }

  function handleLayerZeroApiKeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedApiKey = layerZeroApiKeyDraft.trim();
    setLayerZeroApiKey(normalizedApiKey);

    try {
      if (normalizedApiKey) {
        window.localStorage.setItem(LAYERZERO_API_KEY_STORAGE_KEY, normalizedApiKey);
      } else {
        window.localStorage.removeItem(LAYERZERO_API_KEY_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures and continue with the in-memory key for this session.
    }

    setLayerZeroApiKeyError(null);
    setIsLayerZeroApiKeyModalOpen(false);
    startTransition(() => {
      setTokenDisplaySource("layerzero");
    });
  }

  function handleToggleRouteSource() {
    if (tokenDisplaySource === "stargate") {
      openLayerZeroApiKeyModal();
      return;
    }

    startTransition(() => {
      setTokenDisplaySource("stargate");
    });
  }

  function openCreateCustomOftConfig() {
    const defaultSourceChainKey =
      customOftSourceChains.find((chain) => chain.chainKey === srcChainKey)?.chainKey ??
      customOftSourceChains[0]?.chainKey ??
      supportedChains[0]?.chainKey ??
      "";
    const defaultDestinationChainKey =
      supportedChains.find(
        (chain) => chain.chainKey === dstChainKey && chain.chainKey !== defaultSourceChainKey,
      )?.chainKey ??
      supportedChains.find((chain) => chain.chainKey !== defaultSourceChainKey)?.chainKey ??
      "";

    setCustomOftConfigDraft({
      json: createCustomOftJsonTemplate(defaultSourceChainKey, defaultDestinationChainKey),
    });
    setCustomOftConfigError(null);
  }

  function closeCustomOftConfigModal() {
    setCustomOftConfigDraft(null);
    setCustomOftConfigError(null);
  }

  function handleCustomOftConfigSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!customOftConfigDraft) {
      return;
    }

    try {
      const parsedConfigs = dedupeCustomOftConfigs(
        parseStoredCustomOftConfigs(customOftConfigDraft.json),
      );

      if (!parsedConfigs.length) {
        throw new Error("No valid OFT meshes were found in this JSON.");
      }

      const validationError = validateCustomOftConfigs(parsedConfigs, chainByKey);

      if (validationError) {
        throw new Error(validationError);
      }

      if (customOftConfigDraft.id) {
        if (parsedConfigs.length !== 1) {
          throw new Error("Edit mode expects exactly one OFT mesh in LayerZero /list format.");
        }

        const upsertedConfig = upsertCustomOftConfig(customOftConfigs, {
          ...parsedConfigs[0],
          id: customOftConfigDraft.id,
        });

        setCustomOftConfigs(upsertedConfig.configs);
        setSelectedCustomOftConfigId(upsertedConfig.storedConfig.id);
        setCustomOftConfigError(null);
        setCustomOftConfigDraft(null);
        pushExecutionNotification({
          tone: "success",
          title:
            upsertedConfig.mode === "created"
              ? "Custom OFT saved"
              : "Custom OFT updated",
          message: `${upsertedConfig.storedConfig.name} · ${Object.keys(upsertedConfig.storedConfig.deployments).length} chains`,
        });
      } else {
        const mergedConfigs = mergeImportedCustomOftConfigs(customOftConfigs, parsedConfigs);

        if (!mergedConfigs.createdCount && !mergedConfigs.updatedCount) {
          throw new Error("No new or updated custom OFT configs were detected.");
        }

        setCustomOftConfigs(mergedConfigs.configs);
        setSelectedCustomOftConfigId(mergedConfigs.configs[0]?.id ?? "");
        setCustomOftConfigError(null);
        setCustomOftConfigDraft(null);
        pushExecutionNotification({
          tone: "success",
          title: "Custom OFT saved",
          message: `${mergedConfigs.createdCount} created · ${mergedConfigs.updatedCount} updated`,
        });
      }

    } catch (error) {
      setCustomOftConfigError(getErrorMessage(error));
    }
  }

  function handleDeleteCustomOftConfig() {
    if (!selectedCustomOftConfig) {
      return;
    }

    if (!window.confirm(`Delete custom OFT config "${selectedCustomOftConfig.name}"?`)) {
      return;
    }

    setCustomOftConfigs((current) =>
      current.filter((config) => config.id !== selectedCustomOftConfig.id),
    );
  }

  function handleExportCustomOftConfigs() {
    if (!customOftConfigs.length) {
      pushExecutionNotification({
        tone: "danger",
        title: "No custom OFTs",
        message: "Add at least one custom OFT config before exporting.",
      });
      return;
    }

    const blob = new Blob([JSON.stringify(serializeCustomOftConfigs(customOftConfigs), null, 2)], {
      type: "application/json",
    });
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = `earthbound-custom-oft-configs-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.URL.revokeObjectURL(objectUrl);
    pushExecutionNotification({
      tone: "success",
      title: "Configs exported",
      message: `${customOftConfigs.length} custom OFT config(s).`,
    });
  }

  function openImportCustomOftConfigs() {
    customOftImportInputRef.current?.click();
  }

  async function handleImportCustomOftConfigs(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const importedConfigs = dedupeCustomOftConfigs(parseStoredCustomOftConfigs(text));

      if (!importedConfigs.length) {
        throw new Error("No valid custom OFT configs were found in this file.");
      }

      const validationError = validateCustomOftConfigs(importedConfigs, chainByKey);

      if (validationError) {
        throw new Error(validationError);
      }

      const mergedConfigs = mergeImportedCustomOftConfigs(customOftConfigs, importedConfigs);

      if (!mergedConfigs.createdCount && !mergedConfigs.updatedCount) {
        throw new Error("No new or updated custom OFT configs were detected.");
      }

      setCustomOftConfigs(mergedConfigs.configs);
      setSelectedCustomOftConfigId(mergedConfigs.configs[0]?.id ?? "");
      pushExecutionNotification({
        tone: "success",
        title: "Configs imported",
        message: `${mergedConfigs.createdCount} created · ${mergedConfigs.updatedCount} updated`,
      });
    } catch (error) {
      pushExecutionNotification({
        tone: "danger",
        title: "Import failed",
        message: getErrorMessage(error),
        persistent: true,
      });
    }
  }

  function handleImportDiscoveredOftConfig(payload: OftDiscoveryImportPayload) {
    const nextConfig: CustomOftConfig = {
      id: createStableId(),
      name: payload.name,
      symbol: payload.symbol,
      endpointVersion: payload.endpointVersion,
      deployments: payload.deployments,
    };
    const upsertedConfig = upsertCustomOftConfig(customOftConfigs, nextConfig);

    setCustomOftConfigs(upsertedConfig.configs);
    setSelectedCustomOftConfigId(upsertedConfig.storedConfig.id);
    pushExecutionNotification({
      tone: "success",
      title:
        upsertedConfig.mode === "created"
          ? "Custom OFT imported"
          : "Custom OFT updated",
      message: `${upsertedConfig.storedConfig.name} · ${Object.keys(upsertedConfig.storedConfig.deployments).length} chains`,
    });
  }

  function handleConnectSourceWallet() {
    setWalletManagerNetwork(WALLET_NETWORKS.find((network) => network.type === sourceChainType)?.type ?? "EVM");
    setIsWalletManagerOpen(true);
  }

  async function handleConnectWallet(network: WalletNetwork, walletId: string) {
    if (network === "EVM") {
      const connector = evmWalletConnectors.find((candidate) => candidate.uid === walletId);
      if (!connector) throw new Error("Selected EVM wallet is no longer available.");
      if (isConnected) await disconnectAsync();
      await connectAsync({ connector });
      return;
    }
    if (network === "TON") {
      setIsWalletManagerOpen(false);
      try {
        await bridgeWallets.connectWallet(network, walletId);
      } catch (error) {
        pushExecutionNotification({ tone: "danger", title: "Wallet connection failed", message: getErrorMessage(error), persistent: true });
      }
      return;
    }
    await bridgeWallets.connectWallet(network, walletId);
  }

  async function handleDisconnectWallet(network: WalletNetwork) {
    if (network === "EVM") await disconnectAsync();
    else await bridgeWallets.disconnectWallet(network);
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
    try {
      const savedApiKey = window.localStorage.getItem(LAYERZERO_API_KEY_STORAGE_KEY)?.trim();

      if (savedApiKey) {
        setLayerZeroApiKey(savedApiKey);
      }
    } catch {
      // Ignore storage failures.
    }
  }, []);

  useEffect(() => {
    try {
      setCustomOftConfigs(
        dedupeCustomOftConfigs(
          parseStoredCustomOftConfigs(
            window.localStorage.getItem(CUSTOM_OFT_CONFIGS_STORAGE_KEY),
          ),
        ),
      );
    } catch {
      setCustomOftConfigs([]);
    }
  }, []);

  useEffect(() => {
    try {
      if (customOftConfigs.length) {
        window.localStorage.setItem(
          CUSTOM_OFT_CONFIGS_STORAGE_KEY,
          JSON.stringify(customOftConfigs),
        );
      } else {
        window.localStorage.removeItem(CUSTOM_OFT_CONFIGS_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [customOftConfigs]);

  useEffect(() => {
    if (!customOftConfigs.length) {
      setSelectedCustomOftConfigId("");
      setSelectedCustomOftSrcChainKey("");
      setSelectedCustomOftDstChainKey("");
      return;
    }

    setSelectedCustomOftConfigId((current) => {
      if (current && customOftConfigs.some((config) => config.id === current)) {
        return current;
      }

      return customOftConfigs[0].id;
    });
  }, [customOftConfigs]);

  useEffect(() => {
    if (!selectedCustomOftConfig) {
      setSelectedCustomOftSrcChainKey("");
      return;
    }

    setSelectedCustomOftSrcChainKey((current) => {
      if (current && customOftRuntimeSourceChains.some((chain) => chain.chainKey === current)) {
        return current;
      }

      return "";
    });
  }, [customOftRuntimeSourceChains, selectedCustomOftConfig]);

  useEffect(() => {
    if (!selectedCustomOftConfig) {
      setSelectedCustomOftDstChainKey("");
      return;
    }

    setSelectedCustomOftDstChainKey((current) => {
      if (
        current &&
        customOftRuntimeDestinationChains.some((chain) => chain.chainKey === current)
      ) {
        return current;
      }

      return "";
    });
  }, [customOftRuntimeDestinationChains, selectedCustomOftConfig]);

  useEffect(() => {
    setSrcChainKey((current) => {
      if (current && supportedChains.some((chain) => chain.chainKey === current)) {
        return current;
      }

      return "";
    });
  }, [supportedChains]);

  useEffect(() => {
    setDstChainKey((current) => {
      if (
        current &&
        current !== srcChainKey &&
        supportedChains.some((chain) => chain.chainKey === current)
      ) {
        return current;
      }

      return "";
    });
  }, [srcChainKey, supportedChains]);

  // Apply initial URL params once supportedChains (and tokens, if needed) are loaded
  useEffect(() => {
    if (initialUrlParamsRef.current.applied) return;
    if (supportedChains.length === 0) return;

    const { srcChain, dstChain, srcToken, dstToken } = initialUrlParamsRef.current;

    // If token params are present, wait for the tokens catalog too so the
    // validation effect doesn't immediately clear them (srcTokens would be
    // empty before the catalog loads and would trigger a spurious clear).
    if ((srcToken || dstToken) && !tokensQuery.data) return;

    initialUrlParamsRef.current.applied = true;

    if (srcChain && supportedChains.some((c) => c.chainKey === srcChain)) {
      setSrcChainKey(srcChain);
    }
    if (dstChain && dstChain !== srcChain && supportedChains.some((c) => c.chainKey === dstChain)) {
      setDstChainKey(dstChain);
    }
    if (srcToken) {
      // Setting srcTokenAddress triggers the [srcTokenAddress] cleanup effect which
      // would clear dstTokenAddress. Use the skip flag to suppress that one-time reset.
      if (dstToken) skipDstTokenResetRef.current = srcToken;
      setSrcTokenAddress(srcToken);
    }
    if (dstToken) setDstTokenAddress(dstToken);
    setUrlSelectionReady(true);
  }, [supportedChains, tokensQuery.data]);

  // Sync selected chain/token state to URL
  useEffect(() => {
    if (!urlSelectionReady) return;
    const params = new URLSearchParams();
    if (srcChainKey) params.set("srcChain", srcChainKey);
    if (dstChainKey) params.set("dstChain", dstChainKey);
    if (srcTokenAddress) params.set("srcToken", srcTokenAddress);
    if (dstTokenAddress) params.set("dstToken", dstTokenAddress);

    const search = params.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}`, { scroll: false });
  }, [srcChainKey, dstChainKey, srcTokenAddress, dstTokenAddress, router, pathname, urlSelectionReady]);

  useEffect(() => {
    isQuotingRef.current = isQuoting;
  }, [isQuoting]);

  useEffect(() => {
    if (
      !sourceChainUsesEvmWallet ||
      !address ||
      !isConnected ||
      !activeSrcChain ||
      !activeBalanceToken ||
      !chainId
    ) {
      balanceSwitchAttemptRef.current = null;
      return;
    }

    if (chainId === activeSrcChain.chainId) {
      balanceSwitchAttemptRef.current = null;
      return;
    }

    if (executionState.phase === "running") {
      return;
    }

    if (isSwitchPending) {
      return;
    }

    const attemptKey = `${evmConnector?.uid}:${address}:${chainId}->${activeSrcChain.chainId}`;

    if (balanceSwitchAttemptRef.current === attemptKey) {
      return;
    }

    balanceSwitchAttemptRef.current = attemptKey;
    if (activeSrcChain.chainKey in walletChainByKey) {
      void switchChainAsync({ chainId: activeSrcChain.chainId as SupportedChainId }).catch(
        () => undefined,
      );
      return;
    }

    void getConnectorEvmProvider(evmConnector).then((provider) => switchInjectedEvmChain(activeSrcChain.chainId, activeSrcChain.shortName, provider)).catch(
      () => undefined,
    );
  }, [
    activeBalanceToken,
    activeSrcChain,
    address,
    chainId,
    executionState.phase,
    isConnected,
    isSwitchPending,
    sourceChainUsesEvmWallet,
    evmConnector,
    switchChainAsync,
  ]);

  useEffect(() => {
    setDstChainKey((current) => {
      if (current && selectableDestinationChains.some((chain) => chain.chainKey === current)) {
        return current;
      }

      return "";
    });
  }, [selectableDestinationChains]);

  useEffect(() => {
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setQuoteWarnings([]);
    setExecutionState({ phase: "idle" });
  }, [srcChainKey]);

  useEffect(() => {
    if (!srcTokenAddress) {
      return;
    }

    if (!srcChainKey) {
      setSrcTokenAddress("");
      return;
    }

    const hasMatchingCatalogToken = srcTokens.some((token) =>
      isMatchingSelectedToken(token, srcChainKey, srcTokenAddress),
    );
    const hasMatchingCustomOftToken = customOftConfigs.some((config) => {
      const deployment = config.deployments[srcChainKey];

      if (!deployment) {
        return false;
      }

      const address = deployment.tokenAddress ?? deployment.oftAddress;

      return address.toLowerCase() === srcTokenAddress.toLowerCase();
    });

    if (!hasMatchingCatalogToken && !hasMatchingCustomOftToken) {
      setSrcTokenAddress("");
    }
  }, [customOftConfigs, srcChainKey, srcTokenAddress, srcTokens]);

  useEffect(() => {
    // Skip the dstTokenAddress reset when both src and dst tokens are being
    // applied together from initial URL params (skipDstTokenResetRef is set).
    if (skipDstTokenResetRef.current && !srcTokenAddress) return;
    if (skipDstTokenResetRef.current === srcTokenAddress) {
      skipDstTokenResetRef.current = null;
    } else {
      setDstTokenAddress("");
    }
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setExecutionState({ phase: "idle" });
  }, [srcTokenAddress]);

  useEffect(() => {
    if (!dstTokenAddress) {
      return;
    }

    if (!dstChainKey) {
      setDstTokenAddress("");
      return;
    }

    if (!destinationTokens.some((token) => isMatchingSelectedToken(token, dstChainKey, dstTokenAddress))) {
      setDstTokenAddress("");
    }
  }, [destinationTokens, dstChainKey, dstTokenAddress]);

  useEffect(() => {
    setQuotes([]);
    setSelectedQuoteRouteKey(null);
    setQuoteError(null);
    setLastQuoteUpdatedAt(null);
    setExecutionState({ phase: "idle" });
    quoteRequestIdRef.current += 1;
    setQuoteWarnings([]);
    isQuotingRef.current = false;
    setIsQuoting(false);
  }, [amountInput, destinationAddress, dstChainKey, dstTokenAddress, srcChainKey, srcTokenAddress, bridgeApiProvider, sourceWalletAddress, activeExternalWalletSession?.walletId, evmConnector?.uid, useApiRoutes]);

  async function requestDirectQuote(simulate = false) {
    if (!quoteRequestState.ready || !srcChain || !dstChain || !selectedSrcToken || !selectedDstToken) {
      throw new Error("Select tokens and enter a valid amount and recipient.");
    }
    if (!supportsDirectOftRoute(srcChain.chainType, dstChain.chainType) ||
      [srcChain, dstChain].some(chain => chain.chainType === "EVM" && !wagmiConfig.chains.some(configured => configured.id === chain.chainId))) {
      throw new Error("Direct OFT supports configured EVM networks, Solana ↔ EVM, TON ↔ EVM, and EVM → Aptos / Starknet / Tron / Sui / Stellar. This route family is not yet supported.");
    }
    const params = new URLSearchParams({
      contractAddresses: selectedSrcToken.address,
      chainNames: `${srcChain.chainKey},${dstChain.chainKey}`,
    });
    const metadata = await queryClient.fetchQuery({
      queryKey: ["bridge", "direct-oft-metadata", params.toString()],
      queryFn: () => fetchJson<LayerZeroOftListResponse>(`/api/bridge/oft-list?${params}`),
      staleTime: 60_000,
    });
    return buildDirectOftQuote({
      metadata, srcChain, dstChain, srcToken: selectedSrcToken, dstToken: selectedDstToken,
      amount: BigInt(quoteRequestState.payload.amount),
      from: sourceWalletAddress, to: destinationAddress,
      solanaRpcUrl: rpcConfig.solana?.[0], simulate,
      readNativeBalance: async (chain, address) => {
        const client = getPublicClient(wagmiConfig, { chainId: chain.chainId });
        if (!client) throw new Error(`No RPC configured for ${chain.shortName}.`);
        return client.getBalance({ address });
      },
      readEvmCode: async (chain, address) => {
        const client = getPublicClient(wagmiConfig, { chainId: chain.chainId });
        if (!client) throw new Error(`No public client for ${chain.chainKey}.`);
        return client.getCode({ address });
      },
      readEvmStorage: async (chain, address, slot) => {
        const client = getPublicClient(wagmiConfig, { chainId: chain.chainId });
        if (!client) throw new Error(`No public client for ${chain.chainKey}.`);
        return client.getStorageAt({ address, slot });
      },
      discoverPeers: true,
      fetchDiscoveryQuote: () => fetchJson<BridgeQuoteResponse>("/api/bridge/quotes", {
        method: "POST",
        body: JSON.stringify({ ...quoteRequestState.payload, provider: "stargate" }),
      }),
      read: async <T,>({ chain, ...params }: Parameters<typeof readEvmContractForChain>[0]) => {
        try {
          return await readContract(wagmiConfig, { ...params, chainId: chain.chainId }) as T;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "";
          if (/does not exist|not available|request failed|failed to fetch|econnrefused|timed? ?out/i.test(msg))
            throw new Error(`Failed to read on-chain data on ${chain.shortName ?? chain.chainKey}. Check your RPC settings.`);
          throw error;
        }
      },
    });
  }

  async function handleRequestQuote(mode: "auto" | "manual" | "refresh" = "manual") {
    if (isCustomOftSource) {
      return;
    }

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
      const requests: Array<{ label: string; result: Promise<BridgeQuoteResponse> }> = [];
      const supportsExistingRoute = selectedSrcToken?.bridgeProviders?.includes("layerzero") && selectedDstToken?.bridgeProviders?.includes("layerzero");
      if (supportsExistingRoute) requests.push({
        label: "Other routes",
        result: !useApiRoutes
          ? requestDirectQuote().then(direct => ({ quotes: [direct] }))
          : fetchJson<BridgeQuoteResponse>("/api/bridge/quotes", {
            method: "POST", headers: getBridgeApiRequestHeaders(bridgeApiProvider, layerZeroApiKey),
            body: JSON.stringify(quoteRequestState.payload),
          }),
      });
      if (supportsCcipPair(selectedSrcToken, selectedDstToken)) requests.push({
        label: "CCIP",
        result: fetchJson<BridgeQuoteResponse>("/api/bridge/quotes", {
          method: "POST", body: JSON.stringify({ ...quoteRequestState.payload, provider: "ccip" }),
        }),
      });
      const results = await Promise.allSettled(requests.map(request => request.result));
      const warnings: string[] = [];
      const quoteResponse: BridgeQuoteResponse = { quotes: [], rejectedQuotes: [] };
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          quoteResponse.quotes.push(...result.value.quotes);
          if (!result.value.quotes.length) warnings.push(`${requests[index].label}: ${result.value.rejectedQuotes?.[0]?.error ?? "No quote available."}`);
        } else warnings.push(`${requests[index].label}: ${getErrorMessage(result.reason)}`);
      });
      quoteResponse.rejectedQuotes = warnings.map(error => ({ error }));

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
      setQuoteWarnings(warnings);
      setQuotedRequestKey(quoteRequestKey);
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

      setQuotes([]);
      setQuoteWarnings([]);
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
    if (isCustomOftSource || !quoteRequestState.ready || executionState.phase === "running") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestQuoteRef.current("auto");
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCustomOftSource, executionState.phase, quoteRequestKey, quoteRequestState.ready]);

  useEffect(() => {
    if (isCustomOftSource || !quoteRequestState.ready || executionState.phase === "running") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestQuoteRef.current("refresh");
    }, lastQuoteUpdatedAt ? Math.max(0, lastQuoteUpdatedAt + 10_000 - Date.now()) : 10_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    isCustomOftSource,
    executionState.phase,
    lastQuoteUpdatedAt,
    quoteRequestKey,
    quoteRequestState.ready,
  ]);

  useEffect(() => {
    if (
      isCustomOftSource ||
      !quoteRequestState.ready ||
      executionState.phase === "running" ||
      !lastQuoteUpdatedAt
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRefreshCountdownNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    isCustomOftSource,
    executionState.phase,
    lastQuoteUpdatedAt,
    quoteRequestKey,
    quoteRequestState.ready,
  ]);

  const executionLockRef = useRef(false);
  const executionContext = JSON.stringify([srcChainKey, dstChainKey, srcTokenAddress, dstTokenAddress,
    amountInput, destinationAddress, sourceWalletAddress, useApiRoutes, selectedCustomOftConfigId]);
  const currentCcipTransferKey = quoteRequestState.ready && sourceWalletAddress ? ccipTransferKey(quoteRequestState.payload, sourceWalletAddress) : undefined;
  const unresolvedSubmittedTransfer = executionHistory.find(item =>
    (item.phase === "pending" || item.phase === "running") &&
    ((item.ccipSubmission && item.ccipTransferKey === currentCcipTransferKey) || (item.solanaSubmission && item.executionKey === executionContext)));
  const executionContextRef = useRef(executionContext);
  useEffect(() => { executionContextRef.current = executionContext; }, [executionContext]);
  function assertCurrentExecutionContext() {
    if (executionContextRef.current !== executionContext)
      throw new Error("Transfer details or wallet changed during execution. Review before retrying.");
  }

  async function handleExecuteQuote() {
    if (!quote || !srcChain || !dstChain || !selectedSrcToken || !selectedDstToken || !quoteRequestState.ready || quotedRequestKey !== quoteRequestKey) {
      return;
    }

    if (executionLockRef.current) return;
    if (unresolvedSubmittedTransfer) {
      pushExecutionNotification({ tone: "neutral", title: "Transaction already submitted", message: "Use Check status in Transfers before sending this transfer again." });
      return;
    }
    executionLockRef.current = true;
    const historyId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const initialHistoryItem: ExecutionHistoryItem = {
      id: historyId,
      quoteId: quote.id,
      executionKey: executionContext,
      ccipTransferKey: quote.provider === "ccip" ? currentCcipTransferKey : undefined,
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
        quote.provider !== "ccip" && quote.dstAmountMin && selectedDstToken
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
      message: `${initialHistoryItem.srcChainName} → ${initialHistoryItem.dstChainName} · ${initialHistoryItem.srcAmount}`,
    });

    try {
      let lastTxHash: string | undefined;
      if (quote.provider === "ccip") {
        if (!address || sourceChainType !== "EVM") throw new Error("Connect an EVM source wallet for CCIP.");
        if (chainId !== srcChain.chainId) await switchEvmChain(srcChain);
        const submitted = (hash: string, confirmed: boolean) => {
          const transferStatus = confirmed ? "PENDING" : "CONFIRMATION_PENDING";
          updateExecutionHistoryItem(historyId, { txHash: hash, ccipSubmission: { chainId: srcChain.chainId, hash, confirmed }, transferStatus,
            currentStep: confirmed ? "Source confirmed. Waiting for CCIP delivery." : "CCIP transaction submitted. Waiting for source confirmation." });
          setExecutionState(current => ({ ...current, txHash: hash, transferStatus }));
        };
        lastTxHash = await executeCcipTransfer(quote, quoteRequestState.payload, srcChain, address, {
          assertContext: () => {
            assertCurrentExecutionContext();
            const current = getAccount(wagmiConfig);
            if (current.address?.toLowerCase() !== address.toLowerCase() || current.chainId !== srcChain.chainId) throw new Error("Wallet account or network changed. Review the transfer again.");
          },
          refresh: async () => {
            const result = await fetchJson<BridgeQuoteResponse>("/api/bridge/quotes", {
              method: "POST", body: JSON.stringify({ ...quoteRequestState.payload, provider: "ccip" }),
            });
            if (!result.quotes[0]) throw new Error("CCIP returned no available route.");
            return result.quotes[0];
          },
          read: args => readEvmContractForChain<bigint>({ ...args, chain: srcChain }),
          send: tx => sendEvmTransactionForChain(srcChain, { ...tx, from: address }),
          wait: async (hash, kind) => {
            const receipt = await waitForTransactionReceipt(wagmiConfig, {
              chainId: srcChain.chainId, hash: hash as Hex,
              onReplaced: ({ reason, transactionReceipt }) => {
                if (kind === "bridge" && reason === "repriced") submitted(transactionReceipt.transactionHash, false);
                if (reason !== "repriced") {
                  if (kind === "bridge" && reason === "cancelled") applyCcipStatus(historyId, { status: "CANCELLED", error: "Source transaction was cancelled in the wallet." });
                  throw new Error("Transaction was cancelled or replaced. Check wallet activity before retrying.");
                }
              },
            });
            if (kind === "bridge" && receipt.status !== "success") applyCcipStatus(historyId, { status: "FAILED", error: "Source transaction reverted. No CCIP transfer was sent." });
            assertSuccessfulEvmReceipt(receipt);
            return receipt.transactionHash;
          },
          submitted,
          step: currentStep => updateExecutionHistoryItem(historyId, { currentStep }),
        });
        pushExecutionNotification({ tone: "neutral", title: "CCIP transfer submitted", message: "Source confirmed. Tracking destination delivery." });
        applyCcipStatus(historyId, { status: "PENDING", substatus: "Source confirmed. Waiting for CCIP delivery." });
        void pollTransferStatus(quote.id, "ccip", undefined, lastTxHash, status => applyCcipStatus(historyId, status)).then(status => {
          if (status?.status === "COMPLETED") pushExecutionNotification({ tone: "success", title: "CCIP transfer completed", message: `${initialHistoryItem.srcAmount} → ${initialHistoryItem.expectedDstAmount}` });
        }).catch(() => {
          applyCcipStatus(historyId, { status: "PENDING", substatus: "CCIP tracking is temporarily unavailable. Use Check status in Transfers to continue." });
        });
        void erc20BalanceQuery.refetch();
        void nativeBalanceQuery.refetch();
        return;
      }
      const isDirectOft = quote.routeSteps.some((step) => step.type === "DIRECT_OFT");
      const refreshDirectQuote = async () => {
        assertCurrentExecutionContext();
        const fresh = await requestDirectQuote(true);
        if (!fresh.directOft || !quote.directOft ||
            BigInt(fresh.dstAmount) < BigInt(quote.dstAmountMin ?? quote.dstAmount) ||
            BigInt(fresh.directOft.nativeFee) > BigInt(quote.directOft.nativeFee) ||
            fresh.directOft.meshKey !== quote.directOft.meshKey) {
          throw new Error("Direct OFT quote changed. Refresh and review the new quote before sending.");
        }
        return fresh;
      };
      let resolvedUserSteps = isDirectOft ? (await refreshDirectQuote()).userSteps : quote.userSteps;
      let latestTransferStatus = "";

      if (!resolvedUserSteps.length) {
        updateExecutionHistoryItem(historyId, {
          currentStep: `Building ${getChainTypeDisplayLabel(sourceChainType)} user steps`,
        });
        const builtUserStepsResponse = await buildUserSteps(
          quote.id,
          quote.provider ?? bridgeApiProvider,
          layerZeroApiKey,
        );

        if (builtUserStepsResponse.userSteps.length) {
          resolvedUserSteps = builtUserStepsResponse.userSteps;
        } else {
          throw new Error("No executable steps returned for this quote.");
        }
      }

      assertExecutionPlan(resolvedUserSteps, srcChain, sourceWalletAddress ?? "");

      if (sourceChainType === "EVM") {
        if (!address) {
          throw new Error("Connect an EVM wallet before executing this route.");
        }

        if (chainId !== srcChain.chainId) {
          updateExecutionHistoryItem(historyId, {
            currentStep: `Switching wallet to ${srcChain.shortName}`,
          });
          pushExecutionNotification({
            tone: "neutral",
            title: "Switch network",
            message: `Switch your wallet to ${srcChain.shortName} to continue.`,
          });
          await switchEvmChain(srcChain);
        }

        for (const [index, step] of resolvedUserSteps.entries()) {
          assertCurrentExecutionContext();
          if (isTransactionStep(step) && step.chainType === "EVM") {
            const freshSend = isDirectOft && index === resolvedUserSteps.length - 1
              ? (await refreshDirectQuote()).userSteps.at(-1) as TransactionUserStep
              : null;
            const payload = freshSend?.transaction.encoded ?? step.transaction?.encoded;

            if (!payload?.to) {
              throw new Error(`Step ${index + 1} is missing transaction payload.`);
            }

            updateExecutionHistoryItem(historyId, {
              currentStep: step.description ?? `Sending transaction step ${index + 1}`,
            });

            assertCurrentExecutionContext();
            const hash = await sendEvmTransactionForChain(srcChain, {
              from: address as Address,
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
              message: shortenAddress(hash),
            });

            const confirmedHash = await waitForEvmTransaction(srcChain, hash);
            lastTxHash = confirmedHash;
            setExecutionState((current) => ({ ...current, txHash: confirmedHash }));
            updateExecutionHistoryItem(historyId, {
              txHash: confirmedHash,
              currentStep: "Transaction confirmed",
            });
            pushExecutionNotification({
              tone: "neutral",
              title: "Transaction confirmed",
              message: shortenAddress(hash),
            });
            continue;
          }

          if (isSignatureStep(step) && step.chainType === "EVM") {
            const typedData = step.signature?.typedData;

            if (!typedData?.primaryType) {
              throw new Error(`Step ${index + 1} is missing typed data.`);
            }

            updateExecutionHistoryItem(historyId, {
              currentStep: step.description ?? `Signing step ${index + 1}`,
            });

            const signingAccount = getAccount(wagmiConfig);
            if (signingAccount.address?.toLowerCase() !== address.toLowerCase() || signingAccount.chainId !== srcChain.chainId)
              throw new Error("Wallet account or network changed before signing.");
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
              headers: getBridgeApiRequestHeaders(bridgeApiProvider, layerZeroApiKey),
              body: JSON.stringify({
                provider: bridgeApiProvider,
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

          throw new Error(
            `Unsupported EVM execution step: ${step.type}${step.chainType ? ` on ${step.chainType}` : ""}.`,
          );
        }
      } else if (sourceChainType) {
        updateExecutionHistoryItem(historyId, {
          currentStep: `Submitting ${getChainTypeDisplayLabel(sourceChainType)} transaction`,
        });
        assertCurrentExecutionContext();
        const submittedTxHash = await bridgeWallets.executeUserSteps(
          sourceChainType,
          resolvedUserSteps,
          sourceWalletAddress ?? "",
          (submission) => {
            lastTxHash = submission.signature;
            setExecutionState((current) => ({ ...current, txHash: submission.signature, transferStatus: "SUBMITTED" }));
            updateExecutionHistoryItem(historyId, { txHash: submission.signature, solanaSubmission: submission, transferStatus: "SUBMITTED", explorerUrl: getLayerZeroScanUrl(submission.signature), currentStep: "Submitted. Waiting for Solana confirmation." });
          },
        );

        if (submittedTxHash) {
          lastTxHash = submittedTxHash;
          setExecutionState((current) => ({
            ...current,
            txHash: submittedTxHash,
          }));
          updateExecutionHistoryItem(historyId, {
            txHash: submittedTxHash,
            currentStep: sourceChainType === "SOLANA" ? "Transaction confirmed" : "Transaction submitted",
          });
          pushExecutionNotification({
            tone: "neutral",
            title: sourceChainType === "SOLANA" ? "Transaction confirmed" : "Transaction submitted",
            message: shortenAddress(submittedTxHash),
          });
        } else {
          updateExecutionHistoryItem(historyId, {
            currentStep: "Transaction submitted",
          });
          pushExecutionNotification({
            tone: "neutral",
            title: "Transaction submitted",
            message: getChainTypeDisplayLabel(sourceChainType),
          });
        }
      } else {
        throw new Error("Missing source chain type.");
      }

      if (isDirectOft) {
        const explorerUrl = getLayerZeroScanUrl(lastTxHash);
        setExecutionState({ phase: "success", activeHistoryId: historyId, txHash: lastTxHash, transferStatus: "SOURCE_CONFIRMED", explorerUrl });
        updateExecutionHistoryItem(historyId, {
          phase: "success", txHash: lastTxHash, transferStatus: "SOURCE_CONFIRMED", explorerUrl,
          currentStep: "Source transaction confirmed. Track destination settlement on LayerZeroScan.",
        });
        pushExecutionNotification({ tone: "success", title: "Direct OFT submitted", message: "Track destination settlement on LayerZeroScan." });
        void erc20BalanceQuery.refetch();
        return;
      }

      updateExecutionHistoryItem(historyId, {
        currentStep: "Waiting for transfer settlement",
      });
      const transferStatus = await pollTransferStatus(
        quote.id,
        quote.provider ?? bridgeApiProvider,
        layerZeroApiKey,
        lastTxHash,
        (status) => {
        const statusError = status.error ?? status.substatus;
        const isTerminal = TRANSFER_TERMINAL_STATUSES.has(status.status);

        updateExecutionHistoryItem(historyId, {
          transferStatus: status.status,
          explorerUrl: status.explorerUrl,
          error: statusError,
          currentStep: isTerminal ? undefined : `Tracking transfer · ${formatTransferStatus(status.status)}`,
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
              message: formatTransferStatus(status.status),
            });
          }
        }
        },
      );

      if (!transferStatus) {
        throw new Error("Transfer status timed out before a terminal update.");
      }

      const succeeded =
        transferStatus.status === "COMPLETED" ||
        transferStatus.status === "DELIVERED" ||
        transferStatus.status === "SUCCEEDED";
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
          ? `${initialHistoryItem.srcAmount} → ${initialHistoryItem.expectedDstAmount}`
          : transferError ?? formatTransferStatus(transferStatus.status),
        persistent: !succeeded,
      });

      if (selectedSrcToken && isNativeToken(selectedSrcToken.address)) {
        void nativeBalanceQuery.refetch();
      } else {
        void erc20BalanceQuery.refetch();
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const ccipRecord = executionHistoryRef.current.find(item => item.id === historyId);
      if (ccipRecord?.ccipSubmission) {
        const phase = ccipRecord.phase === "error" ? "error" : "pending";
        const message = phase === "pending" ? "CCIP transaction was submitted. Use Check status before sending again." : errorMessage;
        updateExecutionHistoryItem(historyId, { phase, error: message, currentStep: undefined });
        setExecutionState(current => ({ ...current, phase, error: message, transferStatus: ccipRecord.transferStatus }));
        pushExecutionNotification({ tone: phase === "pending" ? "neutral" : "danger", title: phase === "pending" ? "Confirmation pending" : "Execution stopped", message });
        return;
      }
      const submittedHash = error && typeof error === "object" && "transactionHash" in error && typeof error.transactionHash === "string" ? error.transactionHash : undefined;
      const pending = error instanceof SolanaConfirmationError && error.outcome === "pending";
      const transferStatus = error instanceof SolanaConfirmationError ? (pending ? "CONFIRMATION_PENDING" : error.outcome === "expired" ? "EXPIRED" : "FAILED") : undefined;
      setExecutionState((current) => ({
        ...current, phase: pending ? "pending" : "error", activeHistoryId: historyId,
        error: errorMessage, transferStatus, txHash: submittedHash ?? current.txHash,
      }));
      updateExecutionHistoryItem(historyId, {
        phase: pending ? "pending" : "error", error: errorMessage, transferStatus,
        ...(submittedHash ? { txHash: submittedHash } : {}), currentStep: undefined,
      });
      pushExecutionNotification({
        tone: pending ? "neutral" : "danger", title: pending ? "Confirmation pending" : "Execution stopped",
        message: pending ? "Transaction submitted. Check its status in Transfers before retrying." : "See the transfer record for details.",
      });
    } finally {
      executionLockRef.current = false;
    }
  }

  const customOftRequestState = useMemo(() => {
    if (!selectedCustomOftConfig) {
      return {
        ready: false,
        reason: "Add a custom OFT config first.",
      } as const;
    }

    if (!customOftRuntimeSourceChains.length) {
      return {
        ready: false,
        reason: "This mesh has no executable local EVM source deployment in this build.",
      } as const;
    }

    if (!customOftRuntimeDestinationChains.length) {
      return {
        ready: false,
        reason: "This mesh has no executable local EVM destination deployment in this build.",
      } as const;
    }

    if (!customOftSrcChain || !customOftDstChain) {
      return {
        ready: false,
        reason: "Choose a source chain and destination chain from this mesh.",
      } as const;
    }

    if (!sourceWalletAddress) {
      return {
        ready: false,
        reason: `${getWalletConnectLabel(customOftSrcChain.chainType)} before executing this OFT.`,
      } as const;
    }

    if (
      !isLocalCustomOftSourceChainSupported(customOftSrcChain.chainType)
    ) {
      return {
        ready: false,
        reason: "Local custom OFT execution currently supports EVM source chains only.",
      } as const;
    }

    if (!selectedCustomOftSourceDeployment || !selectedCustomOftDestinationDeployment) {
      return {
        ready: false,
        reason: "Selected source or destination deployment is unavailable.",
      } as const;
    }

    if (
      !isLocalCustomOftDestinationChainSupported(
        customOftDstChain.chainType,
        customOftDstChain.chainKey,
      )
    ) {
      return {
        ready: false,
        reason: "Local custom OFT execution currently supports EVM destination chains only.",
      } as const;
    }

    if (!isSupportedCustomOftEndpointVersion(selectedCustomOftConfig.endpointVersion)) {
      return {
        ready: false,
        reason: "Local custom OFT execution currently supports Endpoint V2 meshes only.",
      } as const;
    }

    if (
      !destinationAddress ||
      !validateAddressForChainType(customOftDstChain.chainType, destinationAddress)
    ) {
      return {
        ready: false,
        reason: destinationRecipientCopy,
      } as const;
    }

    try {
      const parsedAmount = parseUnits(amountInput || "0", selectedCustomOftSourceDeployment.decimals);

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
          srcChainName: customOftSrcChain.chainKey,
          dstChainName: customOftDstChain.chainKey,
          srcAddress: selectedCustomOftSourceDeployment.oftAddress,
          amount: parsedAmount.toString(),
          from: sourceWalletAddress,
          to: destinationAddress,
          validate: true,
        },
      } as const;
    } catch {
      return {
        ready: false,
        reason: "Enter a valid amount.",
      } as const;
    }
  }, [
    amountInput,
    customOftDstChain,
    customOftSrcChain,
    customOftRuntimeDestinationChains.length,
    customOftRuntimeSourceChains.length,
    destinationRecipientCopy,
    destinationAddress,
    selectedCustomOftConfig,
    selectedCustomOftDestinationDeployment,
    selectedCustomOftSourceDeployment,
    sourceWalletAddress,
  ]);

  async function handleExecuteCustomOft() {
    if (
      !customOftRequestState.ready ||
      !selectedCustomOftConfig ||
      !customOftSrcChain ||
      !customOftDstChain ||
      !selectedCustomOftSourceDeployment ||
      !selectedCustomOftDestinationDeployment
    ) {
      return;
    }

    if (executionLockRef.current) return;
    if (unresolvedSubmittedTransfer) {
      pushExecutionNotification({ tone: "neutral", title: "Transaction already submitted", message: "Use Check status in Transfers before sending this transfer again." });
      return;
    }
    executionLockRef.current = true;
    const historyId = createStableId();
    const initialAmountLabel = `${formatTokenAmount(
      customOftRequestState.payload.amount,
      selectedCustomOftSourceDeployment?.decimals ?? 18,
    )} ${customOftSourceTokenSymbol}`;
    const initialHistoryItem: ExecutionHistoryItem = {
      id: historyId,
      quoteId: `custom-oft:${selectedCustomOftConfig.id}:${customOftSrcChain.chainKey}:${customOftDstChain.chainKey}`,
      phase: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      routeLabel: `Custom OFT · ${selectedCustomOftConfig.name}`,
      srcChainName: customOftSrcChain.shortName,
      dstChainName: customOftDstChain.shortName,
      srcChainIconUrl: getStargateChainIconUrl(customOftSrcChain.chainKey),
      dstChainIconUrl: getStargateChainIconUrl(customOftDstChain.chainKey),
      srcTokenSymbol: customOftSourceTokenSymbol,
      dstTokenSymbol: customOftDestinationTokenSymbol,
      srcTokenIconUrl: customOftSourceTokenIconUrl,
      dstTokenIconUrl: customOftDestinationTokenIconUrl,
      srcAmount: initialAmountLabel,
      expectedDstAmount: `${amountInput || "0"} ${customOftDestinationTokenSymbol}`,
      minimumDstAmount: null,
      destinationAddress,
      currentStep: "Building local OFT transaction",
    };

    prependExecutionHistoryItem(initialHistoryItem);
    setExecutionState({
      phase: "running",
      activeHistoryId: historyId,
    });
    pushExecutionNotification({
      tone: "neutral",
      title: "Execution started",
      message: `${initialHistoryItem.srcChainName} → ${initialHistoryItem.dstChainName} · ${initialHistoryItem.srcAmount}`,
    });

    try {
      if (!address) {
        throw new Error("Connect an EVM wallet before executing this OFT.");
      }

      if (chainId !== customOftSrcChain.chainId) {
        updateExecutionHistoryItem(historyId, {
          currentStep: `Switching wallet to ${customOftSrcChain.shortName}`,
        });
        await switchEvmChain(customOftSrcChain);
      }

      const buildCustomQuote = () => buildCustomOftQuote({
        config: selectedCustomOftConfig,
        srcChain: customOftSrcChain,
        dstChain: customOftDstChain,
        amount: BigInt(customOftRequestState.payload.amount),
        from: customOftRequestState.payload.from,
        to: customOftRequestState.payload.to,
        read: readEvmContractForChain,
      });
      const customQuote = await buildCustomQuote();
      const { userSteps } = customQuote;
      assertExecutionPlan(userSteps, customOftSrcChain, address);
      const quotedDestinationAmountLabel = `${formatTokenAmount(
        customQuote.dstAmount,
        selectedCustomOftDestinationDeployment.decimals,
      )} ${customOftDestinationTokenSymbol}`;

      updateExecutionHistoryItem(historyId, {
        currentStep: "Local OFT transaction ready",
        expectedDstAmount: quotedDestinationAmountLabel,
        minimumDstAmount: quotedDestinationAmountLabel,
      });

      let lastTxHash: string | undefined;

      for (const [index, step] of userSteps.entries()) {
        assertCurrentExecutionContext();
        if (!isTransactionStep(step)) {
          throw new Error(`Unsupported custom OFT step ${index + 1}.`);
        }

        const fresh = index === userSteps.length - 1 ? await buildCustomQuote() : null;
        if (fresh && (fresh.directOft?.meshKey !== customQuote.directOft?.meshKey ||
          BigInt(fresh.dstAmount) < BigInt(customQuote.dstAmountMin ?? customQuote.dstAmount) ||
          BigInt(fresh.directOft!.nativeFee) > BigInt(customQuote.directOft!.nativeFee)))
          throw new Error("Custom OFT quote changed. Review the transfer again.");
        const payload = fresh ? (fresh.userSteps.at(-1) as TransactionUserStep).transaction.encoded : step.transaction?.encoded;

        if (!payload?.to) {
          throw new Error(`Custom OFT step ${index + 1} is missing transaction payload.`);
        }

        updateExecutionHistoryItem(historyId, {
          currentStep: step.description ?? `Sending transaction step ${index + 1}`,
        });

        const hash = await sendEvmTransactionForChain(customOftSrcChain, {
          from: address as Address,
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

        lastTxHash = await waitForEvmTransaction(customOftSrcChain, hash);
        setExecutionState((current) => ({ ...current, txHash: lastTxHash }));
        updateExecutionHistoryItem(historyId, { txHash: lastTxHash });
      }

      const explorerUrl = getLayerZeroScanUrl(lastTxHash);

      setExecutionState({
        phase: "success",
        activeHistoryId: historyId,
        txHash: lastTxHash,
        transferStatus: "SOURCE_CONFIRMED",
        explorerUrl,
      });
      updateExecutionHistoryItem(historyId, {
        phase: "success",
        txHash: lastTxHash,
        transferStatus: "SOURCE_CONFIRMED",
        explorerUrl,
        currentStep: "Source transaction confirmed. Track destination settlement on LayerZeroScan.",
      });
      pushExecutionNotification({
        tone: "success",
        title: "Custom OFT submitted",
        message: lastTxHash ? shortenAddress(lastTxHash) : initialHistoryItem.expectedDstAmount,
      });

      if (activeBalanceToken && isNativeToken(activeBalanceToken.address)) {
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
        title: "Custom OFT failed",
        message: errorMessage,
        persistent: true,
      });
    } finally {
      executionLockRef.current = false;
    }
  }

  const canRequestQuote = !isCustomOftSource && quoteRequestState.ready;
  const canFillMax = Boolean(activeBalanceToken && selectedBalanceValue !== undefined);
  const quoteReady = Boolean(quote && selectedSrcToken && selectedDstToken);
  const destinationPreviewAmount =
    quote && selectedDstToken
      ? formatTokenAmount(quote.dstAmount, selectedDstToken.decimals)
      : "0.00";
  const customOftDestinationPreviewAmount = amountInput.trim() || "0.00";
  const receiveAmount = quote?.provider === "ccip" ? quote.dstAmount : quote?.dstAmountMin;
  const minimumReceiveCopy =
    selectedDstToken && receiveAmount
      ? `${formatTokenAmount(receiveAmount, selectedDstToken.decimals)} ${selectedDstTokenSymbol}`
      : null;
  const refreshCountdownSeconds =
    canRequestQuote && lastQuoteUpdatedAt
      ? Math.max(0, Math.ceil((lastQuoteUpdatedAt + 10_000 - refreshCountdownNow) / 1_000))
      : null;
  const canExecuteQuote =
    Boolean(quote) &&
    (!quote?.ccip || sourceChainHasConfiguredWallet) &&
    !unresolvedSubmittedTransfer &&
    !isQuoting &&
    !quoteError &&
    executionState.phase !== "running" &&
    sourceWalletConnected &&
    canExecuteSelectedSourceChain;
  const canExecuteCustomOft =
    isCustomOftSource &&
    customOftRequestState.ready &&
    !unresolvedSubmittedTransfer &&
    executionState.phase !== "running" &&
    sourceWalletConnected &&
    canExecuteSelectedSourceChain;
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

  const tokenDisplaySourceLabel =
    tokenDisplaySource === "stargate" ? "Standard" : "Direct API";
  const tokenDisplaySourceNextLabel =
    tokenDisplaySource === "stargate" ? "Switch to Direct API" : "Switch to Standard";
  const walletConnectPending = sourceChainUsesEvmWallet
    ? isConnectPending
    : bridgeWallets.isPending;
  const providerNoticeCopy =
    isCustomOftSource
      ? customOftRequestState.reason
      : isLayerZeroFallback
        ? "Using default API routes. Add an API key to enable Direct API."
        : null;
  const executionCapabilityCopy =
    quote?.ccip && !sourceChainHasConfiguredWallet
      ? "CCIP sending requires a configured RPC for the source network."
      : activeSrcChain && !canExecuteSelectedSourceChain
      ? `${getChainTypeDisplayLabel(activeSrcChain.chainType)} source execution is not available in this build yet.`
      : null;
  function handleFillMax() {
    if (!activeBalanceToken || selectedBalanceValue === undefined) {
      return;
    }

    setAmountInput(formatUnits(selectedBalanceValue, activeBalanceToken.decimals));
  }

  function handleConnectDestinationWallet() {
    if (!destinationWalletNetwork) return;
    setThirdPartyRecipient(null);
    setWalletManagerNetwork(destinationWalletNetwork);
    setIsWalletManagerOpen(true);
  }

  return (
    <div className="bridge-shell relative min-h-dvh bg-[var(--background)] text-[var(--foreground)]">
      <input
        ref={customOftImportInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportCustomOftConfigs}
        className="hidden"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent,rgba(255,255,255,0.025)_40%,transparent)]" />

      <div className="bridge-layout relative z-10 flex min-h-dvh w-full flex-col gap-3 p-3 sm:p-4">
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
            <h1 className="text-sm font-semibold tracking-tight text-white">Earthbound</h1>
            <span className="text-[11px] text-[var(--muted)]">Powered by</span>
            <a
              href="https://web3resear.ch"
              target="_blank"
              rel="noreferrer"
              aria-label="Open the Web3Resear.ch website"
              className="text-xs font-medium text-white/80 transition hover:text-white"
            >
              🦒Web3Resear.ch
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <a
              href={GITHUB_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open the Earthbound GitHub repository"
              title="GitHub"
              className={ICON_BUTTON_CLASS}
            >
              <GitHubIcon />
            </a>
            <button
              type="button"
              onClick={() => setIsRpcSettingsOpen(true)}
              className={ICON_BUTTON_CLASS}
              aria-label="Configure RPC endpoints"
              title="Configure RPC endpoints"
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              disabled={walletConnectPending}
              onClick={handleConnectSourceWallet}
              title="Select, switch, or disconnect wallets"
              className={`${PRIMARY_BUTTON_CLASS} gap-2`}
            >
              <WalletIcon className="h-3.5 w-3.5" />
              Wallets
              {sourceWalletConnected ? <span className="font-normal opacity-70">{shortenAddress(sourceWalletAddress)}</span> : null}
            </button>
          </div>
        </header>

        <main className="bridge-main grid min-w-0 flex-1 gap-3">
          <section
            id="transfer"
            className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] rounded-[1.75rem] border border-white/10 bg-[var(--panel)] p-4 shadow-[0_30px_100px_rgba(0,0,0,0.32)] backdrop-blur sm:p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              <div className="flex items-center gap-3">
                <StatusPill tone="neutral">Bridge</StatusPill>
                <p className="text-sm font-medium text-white">Transfer</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCustomOftSetupModalOpen(true)}
                  title={customOftConfigs.length ? `${customOftConfigs.length} custom OFT config(s)` : "Add custom OFT config"}
                  className={`${GHOST_BUTTON_CLASS} gap-2`}
                >
                  Custom OFT
                  <span className="text-white/50">{customOftConfigs.length || "+"}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleRouteSource}
                  aria-label={tokenDisplaySourceNextLabel}
                  title={tokenDisplaySourceNextLabel}
                  className={`${GHOST_BUTTON_CLASS} gap-2`}
                >
                  {tokenDisplaySourceLabel}
                  <SwitchIcon className="h-3.5 w-3.5 shrink-0 text-white/60" />
                </button>
                {executionState.transferStatus ? (
                  <StatusPill tone={executionTone}>{formatTransferStatus(executionState.transferStatus)}</StatusPill>
                ) : null}
              </div>
            </div>

            <div className="bridge-route-panels mt-3 grid min-h-0 min-w-0 gap-3">
                  <div
                    className={`${SURFACE_CARD_CLASS} grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] p-4`}
                  >
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
                          From
                        </p>
                        <p className="mt-1 text-sm font-medium text-white">Origin</p>
                      </div>

                      <label className="block min-w-0 w-full max-w-[24rem] space-y-2">
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

                    <div className="mt-3 grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                      <InlineOptionList
                        title="Chain"
                        items={srcChainItems}
                        emptyState="No source chains."
                        loadingLabel={chainsQuery.isPending ? "Loading chains..." : null}
                      />

                      <InlineOptionList
                        title="Token"
                        items={[...srcTokenItems, ...customOftSrcTokenItems]}
                        emptyState="No source tokens."
                        loadingLabel={tokensQuery.isPending ? "Loading tokens..." : null}
                      />
                    </div>
                  </div>

                  <div
                    className={`${SURFACE_CARD_CLASS} grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] p-4`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[var(--muted-strong)]">
                          To
                        </p>
                        <p className="mt-1 text-sm font-medium text-white">Destination</p>
                      </div>
                      <div className="min-w-0 text-right">
                        <div className="flex items-center justify-end gap-1 text-[var(--muted)]">
                          <ArrowDownIcon className="h-2.5 w-2.5" />
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em]">Receive</p>
                        </div>
                        <p className="mt-1 truncate text-lg font-medium tracking-[-0.04em] text-white">
                          {isCustomOftSource ? customOftDestinationPreviewAmount : destinationPreviewAmount}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          <InlineAssetLabel
                            label={isCustomOftSource ? customOftDestinationTokenSymbol : selectedDstTokenSymbol}
                            src={isCustomOftSource ? customOftDestinationTokenIconUrl : selectedDstTokenIconUrl}
                          >
                            {isCustomOftSource ? customOftDestinationTokenSymbol : selectedDstTokenSymbol}
                          </InlineAssetLabel>
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                      <InlineOptionList
                        title="Chain"
                        items={isCustomOftSource ? customOftDstChainItems : dstChainItems}
                        emptyState={isCustomOftSource ? "No OFT destination chains." : "No destination chains."}
                        loadingLabel={chainsQuery.isPending ? "Loading chains..." : null}
                      />

                      <InlineOptionList
                        title="Token"
                        items={isCustomOftSource ? customOftDstTokenItems : dstTokenItems}
                        emptyState={isCustomOftSource ? "No OFT destination token." : "No destination tokens."}
                        loadingLabel={(!isCustomOftSource && routeTokensQuery.isPending) ? "Loading routes..." : null}
                      />
                    </div>
                  </div>
                </div>

                {quoteError || providerNoticeCopy || executionCapabilityCopy ? (
                  <div className="mt-3 rounded-[1.25rem] border border-white/18 bg-white/[0.04] px-4 py-3 text-sm text-white">
                    <p>{quoteError ?? providerNoticeCopy ?? executionCapabilityCopy}</p>
                    {!useApiRoutes && quoteError?.includes("Enable API routes") ? (
                      <button type="button" onClick={() => setUseApiRoutes(true)} className="mt-2 rounded-full border border-white/20 px-3 py-2 text-xs hover:bg-white/10">Use API routes (provider fees apply)</button>
                    ) : null}
                  </div>
                ) : null}

                {!isCustomOftSource && quote?.provider === "ccip" ? (
                  <p className="mt-3 text-xs text-[var(--muted)]">Send with CCIP from your wallet. The displayed fee includes a 1% ceiling; only the current fee is sent. Source network gas is additional.</p>
                ) : null}
                {[...new Set([...(chainsQuery.data?.warnings ?? []), ...(tokensQuery.data?.warnings ?? []), ...(routeTokensQuery.data?.warnings ?? []), ...quoteWarnings])].map(warning => (
                  <p key={warning} role="status" className="mt-2 text-xs text-amber-200/80">{warning}</p>
                ))}

                <div className="mt-3 grid gap-3 rounded-[1.15rem] border border-white/10 bg-white/[0.03] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.45fr)_minmax(12rem,0.8fr)]">
                      <div className="block space-y-1.5">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                            Destination address
                          </span>
                          <button
                            type="button"
                            onClick={handleConnectDestinationWallet}
                            disabled={!destinationWalletNetwork}
                            title={hasPreferredDestinationWalletAddress ? `Manage ${destinationWalletLabel}` : "Connect destination wallet"}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-white/72 transition hover:text-white disabled:cursor-not-allowed disabled:text-white/30"
                          >
                            <WalletIcon className="h-3 w-3" />
                            {hasPreferredDestinationWalletAddress
                              ? destinationWalletLabel
                              : `Connect ${getChainTypeDisplayLabel(destinationChainType)}`}
                          </button>
                        </span>
                        <input
                          aria-label="Destination address"
                          placeholder={useThirdPartyRecipient ? destinationAddressPlaceholder : "Connect destination wallet"}
                          value={destinationAddress}
                          readOnly={!useThirdPartyRecipient}
                          onChange={(event) => { if (activeDstChain && useThirdPartyRecipient) setThirdPartyRecipient({ chainKey: activeDstChain.chainKey, address: event.target.value.trim() }); }}
                          className={`${FIELD_CLASS} h-10 rounded-[1.05rem] px-3 py-2 text-xs`}
                        />
                        <ToggleSwitch
                          checked={useThirdPartyRecipient}
                          disabled={!activeDstChain}
                          onCheckedChange={(checked) => setThirdPartyRecipient(checked && activeDstChain ? { chainKey: activeDstChain.chainKey, address: "" } : null)}
                        >
                          Send to a third-party address
                        </ToggleSwitch>
                        {!useThirdPartyRecipient && activeDstChain && !hasPreferredDestinationWalletAddress ? <p className="text-xs text-amber-200/80">{destinationRecipientCopy}</p> : null}
                      </div>

                      <div className="rounded-[1.05rem] border border-white/10 bg-black px-3 py-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                          {isCustomOftSource ? "Receive" : quote?.provider === "ccip" ? "Est. receive" : "Min receive"}
                        </p>
                        <p className="mt-1.5 text-xs text-white">
                          {isCustomOftSource ? (
                            customOftDestinationToken ? (
                              <InlineAssetLabel
                                label={customOftDestinationTokenSymbol}
                                src={customOftDestinationTokenIconUrl}
                              >
                                {customOftDestinationPreviewAmount} {customOftDestinationTokenSymbol}
                              </InlineAssetLabel>
                            ) : (
                              "Select destination chain"
                            )
                          ) : selectedDstToken ? (
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

                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                  {!isCustomOftSource ? (
                    <ToggleSwitch
                      className="basis-48 flex-1"
                      checked={useApiRoutes}
                      disabled={executionState.phase === "running"}
                      onCheckedChange={setUseApiRoutes}
                    >
                      <span>Use API routes <span className="text-[var(--muted-strong)]">(CCIP always included)</span></span>
                    </ToggleSwitch>
                  ) : null}
                  <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                    {isCustomOftSource ? (
                      <button
                        type="button"
                        onClick={openLayerZeroApiKeyModal}
                        title="Set LayerZero API key"
                        className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 bg-white/[0.04] h-9 px-3 text-xs font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08]"
                      >
                        <KeyIcon className="h-3.5 w-3.5" />
                        <span>API Key</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleRequestQuote("manual")}
                        disabled={!canRequestQuote || isQuoting}
                        title={refreshButtonCopy}
                        className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 bg-white/[0.04] h-9 px-3 text-xs font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshIcon className={`h-3.5 w-3.5 ${isQuoting ? "animate-spin" : ""}`} />
                        <span>{isQuoting ? "Quoting" : "Quote"}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        isCustomOftSource ? void handleExecuteCustomOft() : void handleExecuteQuote()
                      }
                      disabled={isCustomOftSource ? !canExecuteCustomOft : !canExecuteQuote}
                      className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-white h-9 px-3 text-xs font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <SendIcon className="h-3.5 w-3.5" />
                      <span>{executionState.phase === "running" ? "Executing..." : "Execute"}</span>
                    </button>
                  </div>
                  </div>
                </div>
          </section>

          <aside className="bridge-sidebar grid min-h-0 min-w-0 gap-3 rounded-[1.75rem] border border-white/10 bg-[var(--panel)] p-4 shadow-[0_30px_100px_rgba(0,0,0,0.32)] backdrop-blur sm:p-4">
            <section id="quote" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-start justify-between gap-3">
                <SectionHeading
                  compact
                  eyebrow={isCustomOftSource ? "Custom OFT" : "Quote"}
                  title={
                    isCustomOftSource
                      ? selectedCustomOftConfig
                        ? "Saved Config"
                        : "Awaiting"
                      : quoteReady
                        ? "Routes"
                        : "Awaiting"
                  }
                />
                {!isCustomOftSource && quote ? (
                  <StatusPill tone="neutral">{availableQuoteCount} route(s)</StatusPill>
                ) : isCustomOftSource && selectedCustomOftConfig ? (
                  <StatusPill tone="neutral">Local</StatusPill>
                ) : null}
              </div>

              {!isCustomOftSource && quoteReady && quote && selectedSrcToken && selectedDstToken ? (
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
                                {formatQuoteEstimate(candidate.duration?.estimated)} · Fee{" "}
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
                              <div className={`flex items-center gap-1 ${isSelected ? "text-black/66" : "text-[var(--muted)]"}`}>
                                <ArrowDownIcon className="h-2.5 w-2.5" />
                                <p className="text-[10px] font-semibold uppercase tracking-[0.2em]">
                                  Receive
                                </p>
                              </div>
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
                            <span
                              className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold ${
                                isSelected
                                  ? "border-black/12 bg-black/10 text-black/72"
                                  : "border-white/10 bg-black/40 text-white/50"
                              }`}
                            >
                              {index + 1}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : isCustomOftSource ? (
                selectedCustomOftConfig ? (
                  <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
                    <div className="rounded-[1.15rem] border border-white/10 bg-black/70 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        <SettingsIcon className="h-3 w-3 shrink-0" />
                        <p className="text-[9px] font-semibold uppercase tracking-[0.24em]">Config</p>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-white">
                        {selectedCustomOftConfig.name}
                        <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">{selectedCustomOftConfig.symbol}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {selectedCustomOftDeployments.length} chains · {customOftRuntimeSourceChains.length} src
                      </p>
                    </div>
                    <div className="rounded-[1.15rem] border border-white/10 bg-black/70 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        <ArrowRightIcon className="h-3 w-3 shrink-0" />
                        <p className="text-[9px] font-semibold uppercase tracking-[0.24em]">Route</p>
                      </div>
                      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-white">
                        <span>{customOftSrcChain ? (
                          <InlineAssetLabel label={customOftSrcChain.shortName} src={getStargateChainIconUrl(customOftSrcChain.chainKey)} size="xs">
                            {customOftSrcChain.shortName}
                          </InlineAssetLabel>
                        ) : <span className="text-[var(--muted)]">Select source</span>}</span>
                        <ArrowRightIcon className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                        <span>{customOftDstChain ? (
                          <InlineAssetLabel label={customOftDstChain.shortName} src={getStargateChainIconUrl(customOftDstChain.chainKey)} size="xs">
                            {customOftDstChain.shortName}
                          </InlineAssetLabel>
                        ) : <span className="text-[var(--muted)]">Select dest</span>}</span>
                      </p>
                    </div>
                    <div className="rounded-[1.15rem] border border-white/10 bg-black/70 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        <LinkIcon className="h-3 w-3 shrink-0" />
                        <p className="text-[9px] font-semibold uppercase tracking-[0.24em]">Src OFT</p>
                        {selectedCustomOftSourceDeployment?.approvalRequired ? (
                          <span className="ml-auto rounded-full border border-white/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-white/50">Approval</span>
                        ) : null}
                      </div>
                      <p className="mt-1.5 break-all font-mono text-[11px] leading-5 text-white/84">
                        {selectedCustomOftSourceDeployment?.oftAddress ?? <span className="font-sans text-xs text-[var(--muted)]">Select a source chain</span>}
                      </p>
                      {selectedCustomOftSourceDeployment ? (
                        <p className="mt-0.5 text-[10px] text-[var(--muted)]">{selectedCustomOftSourceDeployment.decimals} decimals</p>
                      ) : null}
                    </div>
                    <div className="rounded-[1.15rem] border border-white/10 bg-black/70 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        <LinkIcon className="h-3 w-3 shrink-0" />
                        <p className="text-[9px] font-semibold uppercase tracking-[0.24em]">Dst OFT</p>
                      </div>
                      <p className="mt-1.5 break-all font-mono text-[11px] leading-5 text-white/84">
                        {selectedCustomOftDestinationDeployment?.oftAddress ?? <span className="font-sans text-xs text-[var(--muted)]">Select a destination chain</span>}
                      </p>
                    </div>
                    <div className="rounded-[1.15rem] border border-white/10 bg-black/70 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        <ArrowDownIcon className="h-3 w-3 shrink-0" />
                        <p className="text-[9px] font-semibold uppercase tracking-[0.24em]">Receive</p>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-white">
                        {customOftDestinationPreviewAmount}
                        {customOftDestinationTokenSymbol ? (
                          <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">{customOftDestinationTokenSymbol}</span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
                    Select or create a custom OFT config to enable direct execution.
                  </div>
                )
              ) : (
                <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/12 bg-black/40 px-4 py-3 text-sm text-[var(--muted)]">
                  {isQuoting ? "Requesting live quote..." : "Fill the route to start live quotes."}
                </div>
              )}
            </section>

            <section id="history" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <SectionHeading compact eyebrow="Execution" title="Transfers" />
                <span className="text-xs text-[var(--muted)]">{executionHistory.length ? `${executionHistory.length} recent` : "No activity"}</span>
              </div>
              {historyStorageError ? <p role="status" className="mt-2 text-xs text-amber-200/80">Browser storage is unavailable. These records may be lost when this page closes.</p> : null}
              {executionHistory.length ? (
                <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1" aria-label="Transfer history">
                  {executionHistory.map((item) => (
                    <article key={item.id} className="min-w-0 rounded-xl border border-white/10 bg-black/50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 text-xs font-medium text-white">{item.srcChainName} → {item.dstChainName}</p>
                        <span className={`rounded-full px-2 py-1 text-[10px] ${item.phase === "error" ? "bg-red-400/10 text-red-300" : item.phase === "success" ? "bg-emerald-400/10 text-emerald-200" : "bg-white/10 text-white/70"}`}>
                          {getExecutionHistoryStatus(item)}
                        </span>
                      </div>
                      <p className="mt-2 break-words text-sm font-medium">{item.srcAmount} <span className="font-normal text-white/40">→</span> {item.expectedDstAmount}</p>
                      <p className="mt-1 text-[11px] text-[var(--muted)]">{formatTimeLabel(item.createdAt)} · {formatHistoryRouteLabel(item.routeLabel)}</p>
                      {item.currentStep ? <p className="mt-2 break-words text-xs leading-5 text-white/60">{formatExecutionCopy(item.currentStep)}</p> : null}
                      {item.error ? <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-amber-200/80">{formatExecutionCopy(item.error)}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                        {item.solanaSubmission && (item.phase === "pending" || item.phase === "running" || item.transferStatus === "EXPIRED") ? (
                          <button type="button" disabled={checkingHistoryId !== null || item.phase === "running"} onClick={() => void recheckSolanaHistory(item)} className="rounded-full border border-white/15 px-2.5 py-1.5 hover:bg-white/10 disabled:opacity-40">
                            {checkingHistoryId === item.id ? "Checking…" : "Check status"}
                          </button>
                        ) : null}
                        {item.solanaSubmission ? <a className="text-white/70 hover:text-white" href={`https://solscan.io/tx/${item.solanaSubmission.signature}`} target="_blank" rel="noreferrer">Solscan ↗</a> : null}
                        {item.ccipSubmission && (item.phase === "pending" || item.phase === "running") ? (
                          <button type="button" disabled={checkingHistoryId !== null || item.phase === "running"} onClick={() => void recheckCcipHistory(item)} className="rounded-full border border-white/15 px-2.5 py-1.5 hover:bg-white/10 disabled:opacity-40">
                            {checkingHistoryId === item.id ? "Checking…" : "Check status"}
                          </button>
                        ) : null}
                        {item.explorerUrl ? <a className="text-white/70 hover:text-white" href={item.explorerUrl} target="_blank" rel="noreferrer">{item.ccipSubmission ? "CCIP Explorer" : "LayerZeroScan"} ↗</a> : null}
                      </div>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer py-1 text-white/50 hover:text-white">Details</summary>
                        <dl className="mt-2 space-y-2 break-all text-white/70">
                          <div><dt className="text-white/40">Destination</dt><dd className="mt-1 font-mono">{item.destinationAddress}</dd></div>
                          {item.minimumDstAmount ? <div><dt className="text-white/40">Minimum receive</dt><dd>{item.minimumDstAmount}</dd></div> : null}
                          {item.txHash ? <div><dt className="text-white/40">Transaction</dt><dd className="mt-1 font-mono">{item.txHash}</dd></div> : null}
                        </dl>
                        {item.error ? <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-amber-200/80">{formatExecutionCopy(item.error)}</p> : null}
                      </details>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-32 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <ArrowRightIcon className="h-5 w-5" />
                  <p>Your transfers will appear here.</p>
                  <p className="max-w-56 text-xs leading-5">Follow confirmation, inspect transaction details, and track delivery.</p>
                </div>
              )}
            </section>
          </aside>
        </main>
      </div>

      {isCustomOftSetupModalOpen ? (
        <CustomOftSetupModal
          configs={customOftConfigs}
          selectedConfigId={selectedCustomOftConfigId}
          onSelectConfig={setSelectedCustomOftConfigId}
          onDiscoverMetadata={() => {
            setIsCustomOftSetupModalOpen(false);
            setIsOftDiscoveryModalOpen(true);
          }}
          onManualJson={() => {
            setIsCustomOftSetupModalOpen(false);
            openCreateCustomOftConfig();
          }}
          onExport={handleExportCustomOftConfigs}
          onImport={() => {
            setIsCustomOftSetupModalOpen(false);
            openImportCustomOftConfigs();
          }}
          onDelete={handleDeleteCustomOftConfig}
          onClose={() => setIsCustomOftSetupModalOpen(false)}
        />
      ) : null}
      {isWalletManagerOpen ? (
        <WalletManagerModal
          initialNetwork={walletManagerNetwork}
          sessions={{
            ...bridgeWallets.walletSessionsByChainType,
            ...(isConnected && address ? { EVM: { address, label: evmConnector?.name ?? "EVM Wallet", walletId: evmConnector?.uid } } : {}),
          }}
          getOptions={(network) => network === "EVM"
            ? evmWalletConnectors.map((connector) => ({ id: connector.uid, label: connector.name, installed: true }))
            : bridgeWallets.getWalletOptions(network)}
          onConnect={handleConnectWallet}
          onDisconnect={handleDisconnectWallet}
          onClose={() => setIsWalletManagerOpen(false)}
        />
      ) : null}
      {isRpcSettingsOpen ? (
        <RpcSettingsModal onClose={() => setIsRpcSettingsOpen(false)} />
      ) : null}
      {isLayerZeroApiKeyModalOpen ? (
        <LayerZeroApiKeyModal
          apiKey={layerZeroApiKeyDraft}
          error={layerZeroApiKeyError}
          onApiKeyChange={(value) => {
            setLayerZeroApiKeyDraft(value);
            if (layerZeroApiKeyError) {
              setLayerZeroApiKeyError(null);
            }
          }}
          onClose={closeLayerZeroApiKeyModal}
          onSubmit={handleLayerZeroApiKeySubmit}
        />
      ) : null}
      {customOftConfigDraft ? (
        <CustomOftConfigModal
          draft={customOftConfigDraft}
          error={customOftConfigError}
          onChange={(patch) => {
            setCustomOftConfigDraft((current) => (current ? { ...current, ...patch } : current));
            if (customOftConfigError) {
              setCustomOftConfigError(null);
            }
          }}
          onClose={closeCustomOftConfigModal}
          onSubmit={handleCustomOftConfigSubmit}
        />
      ) : null}
      {isOftDiscoveryModalOpen ? (
        <OftDiscoveryModal
          sourceChains={customOftSourceChains}
          destinationChains={supportedChains}
          existingConfigs={customOftConfigs}
          onClose={() => setIsOftDiscoveryModalOpen(false)}
          onImport={handleImportDiscoveredOftConfig}
        />
      ) : null}

      <div className="pointer-events-none fixed top-3 right-3 z-30 flex max-h-[50dvh] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2">
        {executionNotifications.map((notification) => (
          <div
            key={notification.id}
            className={`pointer-events-auto rounded-[1.25rem] border px-4 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.35)] ${
              notification.tone === "success"
                ? "border-white/30 bg-white text-black"
                : notification.tone === "danger"
                  ? "border-white/18 bg-black text-white"
                  : "border-white/12 bg-[var(--overlay-surface)] text-white"
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
                      notification.message.length > 180 ? "max-h-24" : ""
                    } ${
                      notification.tone === "success" ? "text-black/76" : "text-white/86"
                    }`}
                  >
                    {formatExecutionCopy(notification.message)}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismissExecutionNotification(notification.id)}
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                  notification.tone === "success"
                    ? "border-black/10 bg-black/10 text-black/70 hover:bg-black/15"
                    : "border-white/12 bg-white/[0.04] text-white/72 hover:border-white/24 hover:bg-white/[0.08]"
                }`}
                aria-label="Dismiss notification"
              >
                <XIcon />
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
