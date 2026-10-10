"use client";

import { confirmSolanaSubmission, inspectSolanaSubmission, type SolanaSubmission } from "./solana-confirmation";

import { IotaClient } from "@iota/iota-sdk/client";
import { IOTA_TYPE_ARG } from "@iota/iota-sdk/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { BridgeChainType, QuoteUserStep, TransactionPayload } from "@/lib/bridge-types";
import { loadRpcConfig, getEffectiveRpcUrls } from "@/lib/rpc-config";
import type { WalletOption } from "./wallet-options";

type WalletConnectResult = {
  address: string;
  label: string;
  solanaWalletId?: SolanaWalletId;
  walletId?: string;
};

export type SolanaWalletId = "phantom" | "backpack" | "injected";

type WalletBalanceRequest = {
  chainType: BridgeChainType | undefined | null;
  account: string;
  tokenAddress: string;
};

const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SOLANA_NATIVE_TOKEN_ADDRESSES = new Set([
  NATIVE_TOKEN_ADDRESS,
  "11111111111111111111111111111111",
]);

type SolanaWalletPublicKey = {
  toBase58(): string;
};

type SolanaTransactionResult = {
  signature?: string;
};

type SolanaWalletProvider = {
  isPhantom?: boolean;
  isBackpack?: boolean;
  publicKey?: SolanaWalletPublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: SolanaWalletPublicKey }>;
  disconnect?(): Promise<void>;
  on?(event: "accountChanged" | "disconnect", listener: () => void): void;
  removeListener?(event: "accountChanged" | "disconnect", listener: () => void): void;
  signTransaction?(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  signAndSendTransaction?(
    transaction: VersionedTransaction,
    options?: Record<string, unknown>,
  ): Promise<SolanaTransactionResult>;
};

type AptosTransactionResult = {
  hash?: string;
  txnHash?: string;
  transactionHash?: string;
};

type AptosWalletProvider = {
  name?: string;
  connect(): Promise<{ address?: string }>;
  account?(): Promise<{ address?: string }>;
  disconnect?(): Promise<void>;
  signAndSubmitTransaction?(transaction: unknown): Promise<AptosTransactionResult>;
  signAndSubmitBCSTransaction?(transaction: Uint8Array): Promise<AptosTransactionResult>;
};

type TronBroadcastResult = {
  result?: boolean;
  txid?: string;
  txID?: string;
  code?: string;
  message?: string;
};

type TronWebProvider = {
  defaultAddress?: {
    base58?: string;
  };
  trx?: {
    sign?(transaction: Record<string, unknown>): Promise<Record<string, unknown>>;
    sendRawTransaction?(transaction: Record<string, unknown>): Promise<TronBroadcastResult>;
    sendHexTransaction?(transaction: string): Promise<TronBroadcastResult>;
  };
};

type TronLinkProvider = {
  disconnect?(): Promise<void>;
  request?(args: { method: string }): Promise<unknown>;
  tronWeb?: TronWebProvider;
};

type StarknetWalletCall = {
  contract_address: string;
  entry_point: string;
  calldata?: string[];
};

type StarknetAccountCall = {
  contractAddress: string;
  entrypoint: string;
  calldata?: string[];
};

type StarknetTransactionResult = {
  transaction_hash?: string;
  transactionHash?: string;
};

type StarknetWalletProvider = {
  name?: string;
  disconnect?(): Promise<void>;
  enable?(): Promise<string[] | void>;
  request?(args: {
    type?: string;
    method?: string;
    params?: unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
  selectedAddress?: string;
  account?: {
    address?: string;
    execute?(
      calls: StarknetAccountCall | StarknetAccountCall[],
    ): Promise<StarknetTransactionResult>;
  };
};

type SerializedMoveTransactionExecutor = (args: {
  transaction: string;
  chain: `${string}:${string}`;
}) => Promise<unknown>;

export type TonTransactionRequest = {
  validUntil: number;
  messages: Array<{
    address: string;
    amount: string;
    payload?: string;
    stateInit?: string;
    extraCurrency?: Record<string, string>;
  }>;
};

type TonTransactionExecutor = (
  request: TonTransactionRequest,
) => Promise<{
  boc: string;
}>;

declare global {
  interface Window {
    phantom?: {
      solana?: SolanaWalletProvider;
    };
    solana?: SolanaWalletProvider;
    backpack?: SolanaWalletProvider;
    aptos?: AptosWalletProvider;
    petra?: AptosWalletProvider;
    tronLink?: TronLinkProvider;
    tronWeb?: TronWebProvider;
    starknet?: StarknetWalletProvider;
    starknet_argentX?: StarknetWalletProvider;
    starknet_braavos?: StarknetWalletProvider;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim().length ? value : null;
}

function parseJsonRecord(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue.startsWith("{") && !trimmedValue.startsWith("[")) {
    return null;
  }

  try {
    const parsedValue = JSON.parse(trimmedValue) as unknown;
    return isRecord(parsedValue) ? parsedValue : null;
  } catch {
    return null;
  }
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}

function hexToBytes(value: string) {
  const normalizedValue = value.startsWith("0x") ? value.slice(2) : value;

  if (!normalizedValue.length || normalizedValue.length % 2 !== 0 || !/^[\da-f]+$/i.test(normalizedValue)) {
    throw new Error("Expected a hex-encoded transaction payload.");
  }

  return Uint8Array.from(
    normalizedValue.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function decodeEncodedBytes(value: string) {
  const trimmedValue = value.trim();

  if (/^(0x)?[\da-f]+$/i.test(trimmedValue)) {
    return hexToBytes(trimmedValue);
  }

  return base64ToBytes(trimmedValue);
}

function normalizeSerializedTransactionString(value: string) {
  const trimmedValue = value.trim();

  if (/^(0x)?[\da-f]+$/i.test(trimmedValue)) {
    return bytesToBase64(hexToBytes(trimmedValue));
  }

  return trimmedValue;
}

function getTransactionHash(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directKeys = [
    "hash",
    "txnHash",
    "transactionHash",
    "transaction_hash",
    "txHash",
    "txid",
    "txID",
    "digest",
    "signature",
  ];

  for (const key of directKeys) {
    const candidateValue = value[key];

    if (typeof candidateValue === "string" && candidateValue.trim().length) {
      return candidateValue;
    }
  }

  const nestedTransaction = value.transaction;

  if (isRecord(nestedTransaction)) {
    return getTransactionHash(nestedTransaction);
  }

  return undefined;
}

function getEncodedTransactionPayload(step: QuoteUserStep) {
  const transaction = (step as { transaction?: { encoded?: unknown } }).transaction;
  return isRecord(transaction?.encoded)
    ? (transaction.encoded as TransactionPayload)
    : null;
}

function getSerializedTransactionCandidate(
  encoded: TransactionPayload,
  keys: string[],
): string | null {
  for (const key of keys) {
    const candidateValue = encoded[key];

    if (typeof candidateValue === "string" && candidateValue.trim().length) {
      return candidateValue;
    }

    const parsedCandidate = parseJsonRecord(candidateValue);

    if (parsedCandidate) {
      const nestedCandidate = getSerializedTransactionCandidate(
        parsedCandidate as TransactionPayload,
        keys,
      );

      if (nestedCandidate) {
        return nestedCandidate;
      }
    }
  }

  return null;
}

function getSolanaWalletProvider(walletId?: string): SolanaWalletProvider | null {
  if (typeof window === "undefined") {
    return null;
  }

  const phantom = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
  const backpack = window.backpack ?? (window.solana?.isBackpack ? window.solana : null);
  // An explicit selection must never silently fall back to another wallet.
  if (walletId === "phantom") return phantom;
  if (walletId === "backpack") return backpack;
  if (walletId === "injected") {
    return window.solana && window.solana !== phantom && window.solana !== backpack
      ? window.solana : null;
  }
  if (walletId) return null;
  return phantom ?? backpack ?? window.solana ?? null;
}

function aptosWalletEntries() {
  if (typeof window === "undefined") return [];
  return [
    { id: "petra", label: "Petra", provider: window.petra },
    { id: "aptos", label: window.aptos?.name ?? "Aptos Wallet", provider: window.aptos },
  ].filter((entry, index, entries) => entry.provider && entries.findIndex((other) => other.provider === entry.provider) === index);
}

function starknetWalletEntries() {
  if (typeof window === "undefined") return [];
  return [
    { id: "argentX", label: window.starknet_argentX?.name ?? "Argent X", provider: window.starknet_argentX },
    { id: "braavos", label: window.starknet_braavos?.name ?? "Braavos", provider: window.starknet_braavos },
    { id: "starknet", label: window.starknet?.name ?? "Starknet Wallet", provider: window.starknet },
  ].filter((entry, index, entries) => entry.provider && entries.findIndex((other) => other.provider === entry.provider) === index);
}

function getAptosWalletProvider(walletId?: string) {
  return walletId ? aptosWalletEntries().find((entry) => entry.id === walletId)?.provider : window.aptos ?? window.petra;
}

function getStarknetWalletProvider(walletId?: string) {
  return walletId ? starknetWalletEntries().find((entry) => entry.id === walletId)?.provider : window.starknet ?? window.starknet_argentX ?? window.starknet_braavos;
}

export function getExternalWalletOptions(chainType: BridgeChainType): WalletOption[] {
  if (chainType === "SOLANA") return getSolanaWalletOptions();
  if (typeof window === "undefined") return [];
  if (chainType === "APTOS") return aptosWalletEntries().map(({ id, label }) => ({ id, label, installed: true }));
  if (chainType === "STARKNET") return starknetWalletEntries().map(({ id, label }) => ({ id, label, installed: true }));
  if (chainType === "STELLAR") return [{ id: "freighter", label: "Freighter", installed: Boolean((window as Window & { freighter?: boolean }).freighter) }];
  if (chainType === "TRON") return [{ id: "tronlink", label: "TronLink", installed: Boolean(window.tronLink || window.tronWeb) }];
  return [];
}

export function getSolanaWalletOptions(): { id: SolanaWalletId; label: string; installed: boolean }[] {
  const options: { id: SolanaWalletId; label: string; installed: boolean }[] = [
    { id: "backpack", label: "Backpack", installed: Boolean(getSolanaWalletProvider("backpack")) },
    { id: "phantom", label: "Phantom", installed: Boolean(getSolanaWalletProvider("phantom")) },
  ];
  if (getSolanaWalletProvider("injected")) options.push({ id: "injected", label: "Solana Wallet", installed: true });
  return options;
}

export function subscribeSolanaWallet(walletId: SolanaWalletId, onAddressChange: (address: string | null) => void) {
  const provider = getSolanaWalletProvider(walletId);
  // Backpack and Phantom emit different accountChanged payloads. Both update
  // publicKey before emitting, so use the selected provider as the source.
  const accountChanged = () => onAddressChange(provider?.publicKey?.toBase58() ?? null);
  const disconnected = () => onAddressChange(null);
  provider?.on?.("accountChanged", accountChanged);
  provider?.on?.("disconnect", disconnected);
  accountChanged();
  return () => {
    provider?.removeListener?.("accountChanged", accountChanged);
    provider?.removeListener?.("disconnect", disconnected);
  };
}

function getSolanaConnection() {
  const solanaRpcUrl =
    getEffectiveRpcUrls("solana", loadRpcConfig())[0];
  return new Connection(solanaRpcUrl, "confirmed");
}

function getSuiClient() {
  const suiRpcUrl = getEffectiveRpcUrls("sui", loadRpcConfig())[0];
  return new SuiJsonRpcClient({ network: "mainnet", url: suiRpcUrl });
}

function getIotaClient() {
  const iotaRpcUrl = getEffectiveRpcUrls("iota", loadRpcConfig())[0];
  return new IotaClient({ url: iotaRpcUrl });
}

function getMoveCoinType(tokenAddress: string, nativeCoinType: string) {
  const normalizedTokenAddress = tokenAddress.trim();

  if (normalizedTokenAddress === NATIVE_TOKEN_ADDRESS) {
    return nativeCoinType;
  }

  return normalizedTokenAddress.includes("::") ? normalizedTokenAddress : null;
}

function getParsedTokenAmount(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const account = isRecord(value.account) ? value.account : null;
  const data = isRecord(account?.data) ? account.data : null;
  const parsed = isRecord(data?.parsed) ? data.parsed : null;
  const info = isRecord(parsed?.info) ? parsed.info : null;
  const tokenAmount = isRecord(info?.tokenAmount) ? info.tokenAmount : null;
  return getString(tokenAmount?.amount);
}

function getTronWebProvider() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.tronLink?.tronWeb ?? window.tronWeb ?? null;
}

function getAptosTransactionInput(encoded: TransactionPayload) {
  const directPayload = isRecord(encoded.payload) ? encoded.payload : null;

  if (directPayload) {
    return {
      kind: "payload" as const,
      value: directPayload,
    };
  }

  const nestedTransaction = isRecord(encoded.transaction) ? encoded.transaction : null;

  if (nestedTransaction) {
    return {
      kind: "payload" as const,
      value: nestedTransaction,
    };
  }

  const parsedDataPayload = parseJsonRecord(encoded.data);

  if (parsedDataPayload) {
    return {
      kind: "payload" as const,
      value: parsedDataPayload,
    };
  }

  if (typeof encoded.function === "string") {
    return {
      kind: "payload" as const,
      value: encoded,
    };
  }

  const serializedTransaction = getSerializedTransactionCandidate(encoded, [
    "serializedTransaction",
    "bcs",
    "bytes",
    "data",
    "transaction",
  ]);

  if (serializedTransaction && !serializedTransaction.trim().startsWith("{")) {
    return {
      kind: "bcs" as const,
      value: decodeEncodedBytes(serializedTransaction),
    };
  }

  return null;
}

function getTronTransactionInput(encoded: TransactionPayload) {
  const directTransaction =
    (isRecord(encoded.transaction) && encoded.transaction) ||
    (isRecord(encoded.rawTransaction) && encoded.rawTransaction) ||
    (isRecord(encoded.raw_data) && encoded);

  if (directTransaction) {
    return {
      kind: "object" as const,
      value: directTransaction as Record<string, unknown>,
    };
  }

  const parsedDataTransaction = parseJsonRecord(encoded.data);

  if (parsedDataTransaction) {
    return {
      kind: "object" as const,
      value: parsedDataTransaction,
    };
  }

  const serializedTransaction = getSerializedTransactionCandidate(encoded, [
    "serializedTransaction",
    "signedTransaction",
    "transaction",
    "data",
  ]);

  if (serializedTransaction) {
    return {
      kind: "hex" as const,
      value: serializedTransaction.trim(),
    };
  }

  return null;
}

function toStarknetWalletCall(value: Record<string, unknown>) {
  const contractAddress =
    getString(value.contract_address) ??
    getString(value.contractAddress) ??
    getString(value.to);
  const entryPoint =
    getString(value.entry_point) ??
    getString(value.entrypoint) ??
    getString(value.entryPoint);
  const calldata = Array.isArray(value.calldata)
    ? value.calldata.map((item) => String(item))
    : undefined;

  if (!contractAddress || !entryPoint) {
    return null;
  }

  return {
    contract_address: contractAddress,
    entry_point: entryPoint,
    calldata,
  } satisfies StarknetWalletCall;
}

function toStarknetAccountCall(value: StarknetWalletCall) {
  return {
    contractAddress: value.contract_address,
    entrypoint: value.entry_point,
    calldata: value.calldata,
  } satisfies StarknetAccountCall;
}

function getStarknetTransactionInput(encoded: TransactionPayload) {
  const directCallsValue =
    (Array.isArray(encoded.calls) && encoded.calls) ||
    (isRecord(encoded.transaction) && Array.isArray(encoded.transaction.calls)
      ? encoded.transaction.calls
      : null);

  if (directCallsValue) {
    const calls = directCallsValue
      .map((call) => (isRecord(call) ? toStarknetWalletCall(call) : null))
      .filter(isDefined);

    if (calls.length !== directCallsValue.length) return null;
    if (calls.length) return calls;
  }

  const directCallValue =
    (isRecord(encoded.call) && encoded.call) ||
    (getString(encoded.contract_address) || getString(encoded.contractAddress) ? encoded : null);

  if (isRecord(directCallValue)) {
    const call = toStarknetWalletCall(directCallValue);

    if (call) {
      return [call];
    }
  }

  const parsedDataTransaction = parseJsonRecord(encoded.data);

  if (parsedDataTransaction) {
    return getStarknetTransactionInput(parsedDataTransaction as TransactionPayload);
  }

  return null;
}

function toTonMessage(value: Record<string, unknown>) {
  const address =
    getString(value.address) ??
    getString(value.to) ??
    getString(value.destination);
  const amount =
    getString(value.amount) ??
    getString(value.value);
  const payload =
    getString(value.payload) ??
    getString(value.body) ??
    getString(value.data);
  const stateInit = getString(value.stateInit);
  const extraCurrency = isRecord(value.extraCurrency)
    ? Object.fromEntries(
        Object.entries(value.extraCurrency).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

  if (!address || !amount || !/^[0-9]+$/.test(amount)) {
    return null;
  }

  return {
    address,
    amount,
    payload: payload ?? undefined,
    stateInit: stateInit ?? undefined,
    extraCurrency: extraCurrency && Object.keys(extraCurrency).length ? extraCurrency : undefined,
  };
}

function getTonTransactionInput(encoded: TransactionPayload) {
  if (encoded.validUntil !== undefined && (!Number.isSafeInteger(encoded.validUntil) || Number(encoded.validUntil) <= Math.floor(Date.now() / 1_000))) return null;
  if (encoded.network !== undefined && String(encoded.network) !== "-239") return null;
  const directMessagesValue = Array.isArray(encoded.messages) ? encoded.messages : null;

  if (directMessagesValue) {
    const messages = directMessagesValue
      .map((message) => (isRecord(message) ? toTonMessage(message) : null))
      .filter(isDefined);

    if (messages.length !== directMessagesValue.length) return null;
    if (messages.length) {
      return {
        validUntil:
          typeof encoded.validUntil === "number"
            ? encoded.validUntil
            : Math.floor(Date.now() / 1_000) + 300,
        messages,
      } satisfies TonTransactionRequest;
    }
  }

  const directMessageValue =
    (isRecord(encoded.message) && encoded.message) ||
    (getString(encoded.address) || getString(encoded.to) ? encoded : null);

  if (isRecord(directMessageValue)) {
    const message = toTonMessage(directMessageValue);

    if (message) {
      return {
        validUntil:
          typeof encoded.validUntil === "number"
            ? encoded.validUntil
            : Math.floor(Date.now() / 1_000) + 300,
        messages: [message],
      } satisfies TonTransactionRequest;
    }
  }

  const parsedDataTransaction = parseJsonRecord(encoded.data);

  if (parsedDataTransaction) {
    return getTonTransactionInput(parsedDataTransaction as TransactionPayload);
  }

  return null;
}

function getSerializedMoveTransaction(encoded: TransactionPayload) {
  const serializedTransaction = getSerializedTransactionCandidate(encoded, [
    "serializedTransaction",
    "transaction",
    "transactionBytes",
    "bytes",
    "bcs",
    "data",
  ]);

  return serializedTransaction
    ? normalizeSerializedTransactionString(serializedTransaction)
    : null;
}

async function signAndSubmitAptosPayload(
  provider: AptosWalletProvider,
  payload: Record<string, unknown>,
) {
  if (!provider.signAndSubmitTransaction) {
    throw new Error("The connected Aptos wallet cannot submit transactions.");
  }

  // A submission can succeed even if its response is lost. Never retry a signing
  // operation automatically with a different payload shape.
  return provider.signAndSubmitTransaction(payload);
}

export async function connectExternalWallet(
  chainType: BridgeChainType | undefined | null,
  walletId?: string,
): Promise<WalletConnectResult> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser.");
  }

  switch (chainType) {
    case "SOLANA": {
      const provider = getSolanaWalletProvider(walletId);

      if (!provider) {
        throw new Error("Solana wallet not detected. Install or enable Backpack, Phantom, or a compatible wallet.");
      }

      const result = await provider.connect();
      const address = result.publicKey?.toBase58() ?? provider.publicKey?.toBase58();

      if (!address) {
        throw new Error("Failed to read the connected Solana wallet address.");
      }

      const selected = getSolanaWalletOptions().find((option) => getSolanaWalletProvider(option.id) === provider)!;
      return {
        address,
        label: selected.label,
        solanaWalletId: selected.id,
        walletId: selected.id,
      };
    }
    case "APTOS": {
      const provider = getAptosWalletProvider(walletId);

      if (!provider) {
        throw new Error("No Aptos wallet found. Install Petra or a compatible wallet.");
      }

      const result = await provider.connect();
      const account = (await provider.account?.()) ?? result;
      const address = account.address;

      if (!address) {
        throw new Error("Failed to read the connected Aptos wallet address.");
      }

      return {
        address,
        label: aptosWalletEntries().find((entry) => entry.provider === provider)!.label,
        walletId: aptosWalletEntries().find((entry) => entry.provider === provider)!.id,
      };
    }
    case "TRON": {
      if (walletId && walletId !== "tronlink") throw new Error("Selected Tron wallet is unavailable.");
      await window.tronLink?.request?.({ method: "tron_requestAccounts" });
      const address = getTronWebProvider()?.defaultAddress?.base58;

      if (!address) {
        throw new Error("No Tron wallet found. Install TronLink to continue.");
      }

      return {
        address,
        label: "TronLink",
        walletId: "tronlink",
      };
    }
    case "STARKNET": {
      const provider = getStarknetWalletProvider(walletId);
      if (!provider) {
        throw new Error("No Starknet wallet found. Install Braavos or Argent X.");
      }

      const requestedAccounts = provider.request
        ? await provider.request({ type: "wallet_requestAccounts" })
        : undefined;

      if (!requestedAccounts && provider.enable) {
        await provider.enable();
      }

      const requestedAddress =
        Array.isArray(requestedAccounts) && typeof requestedAccounts[0] === "string"
          ? requestedAccounts[0]
          : undefined;
      const address = requestedAddress ?? provider.selectedAddress ?? provider.account?.address;

      if (!address) {
        throw new Error("Failed to read the connected Starknet wallet address.");
      }

      return {
        address,
        label: starknetWalletEntries().find((entry) => entry.provider === provider)!.label,
        walletId: starknetWalletEntries().find((entry) => entry.provider === provider)!.id,
      };
    }
    case "STELLAR": {
      const { connectStellarWallet } = await import("./stellar-wallet");
      return connectStellarWallet(walletId);
    }
    case "TON":
      throw new Error("TON wallet connection is handled by TonConnect.");
    case "SUI":
      throw new Error("Sui wallet connection is handled by the Sui wallet adapter.");
    case "IOTAMOVE":
      throw new Error("IOTA wallet connection is handled by the IOTA wallet adapter.");
    default:
      throw new Error("Unsupported external wallet type.");
  }
}

export async function disconnectExternalWallet(chainType: BridgeChainType | undefined | null, walletId?: string) {
  if (typeof window === "undefined") {
    return;
  }

  switch (chainType) {
    case "SOLANA":
      await getSolanaWalletProvider(walletId)?.disconnect?.();
      return;
    case "APTOS":
      await getAptosWalletProvider(walletId)?.disconnect?.();
      return;
    case "STARKNET":
      await getStarknetWalletProvider(walletId)?.disconnect?.();
      return;
    case "TRON":
      await window.tronLink?.disconnect?.();
      return;
    default:
      return;
  }
}

export async function fetchExternalWalletBalance({
  chainType,
  account,
  tokenAddress,
}: WalletBalanceRequest) {
  switch (chainType) {
    case "SOLANA": {
      const connection = getSolanaConnection();
      const owner = new PublicKey(account);
      const normalizedTokenAddress = tokenAddress.trim();

      if (SOLANA_NATIVE_TOKEN_ADDRESSES.has(normalizedTokenAddress)) {
        return BigInt(await connection.getBalance(owner));
      }

      const mint = new PublicKey(normalizedTokenAddress);
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
        return tokenAccounts.value.reduce((total, accountInfo) => {
          const amount = getParsedTokenAmount(accountInfo);
          return amount === null ? total : total + BigInt(amount);
        }, BigInt(0));
      } catch (error) {
        // PublicNode restricts indexed owner scans. Direct OFT spends from the
        // ATA, whose balance can still be read without an index or API key.
        if (!/indexed requests require/i.test(String(error))) throw error;
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } =
          await import("@solana/spl-token");
        const mintInfo = await connection.getAccountInfo(mint);
        if (!mintInfo || (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
          throw new Error("Unsupported Solana token program.");
        }
        const ata = getAssociatedTokenAddressSync(mint, owner, true, mintInfo.owner);
        const accountInfo = await connection.getAccountInfo(ata);
        if (!accountInfo) return BigInt(0);
        const account = unpackAccount(ata, accountInfo, mintInfo.owner);
        if (!account.owner.equals(owner) || !account.mint.equals(mint) || !account.isInitialized) {
          throw new Error("Invalid Solana associated token account.");
        }
        return account.isFrozen ? BigInt(0) : account.amount;
      }
    }
    case "SUI": {
      const coinType = getMoveCoinType(tokenAddress, SUI_TYPE_ARG);

      if (!coinType) {
        return undefined;
      }

      const balance = await getSuiClient().getBalance({ owner: account, coinType });
      return BigInt(balance.totalBalance);
    }
    case "IOTAMOVE": {
      const coinType = getMoveCoinType(tokenAddress, IOTA_TYPE_ARG);

      if (!coinType) {
        return undefined;
      }

      const balance = await getIotaClient().getBalance({ owner: account, coinType });
      return BigInt(balance.totalBalance);
    }
    default:
      return undefined;
  }
}

function assertExternalPlan(userSteps: QuoteUserStep[], chainType: string) {
  if (!userSteps.length) throw new Error(`No executable ${chainType} user steps were found.`);
  if (chainType !== "SOLANA" && userSteps.length > 1)
    throw new Error(`Multi-step ${chainType} execution requires confirmed sequencing and is not supported.`);
  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== chainType)
      throw new Error(`Unsupported ${chainType} execution step. No transactions were submitted.`);
    const encoded = getEncodedTransactionPayload(step);
    let valid = false;
    if (encoded) {
      switch (chainType) {
        case "SOLANA": {
          const data = encoded.serializedTransaction ?? encoded.data;
          valid = encoded.encoding === "base64" && typeof data === "string";
          if (valid) VersionedTransaction.deserialize(base64ToBytes(data as string));
          break;
        }
        case "APTOS": valid = Boolean(getAptosTransactionInput(encoded)); break;
        case "TRON": valid = Boolean(getTronTransactionInput(encoded)); break;
        case "STARKNET": valid = Boolean(getStarknetTransactionInput(encoded)?.length); break;
        case "SUI": case "IOTAMOVE": valid = Boolean(getSerializedMoveTransaction(encoded)); break;
        case "TON": valid = Boolean(getTonTransactionInput(encoded)); break;
      }
    }
    if (!valid) throw new Error(`Unsupported ${chainType === "SOLANA" ? "Solana" : chainType === "APTOS" ? "Aptos" : chainType === "TRON" ? "Tron" : chainType === "STARKNET" ? "Starknet" : chainType} transaction payload.`);
  }
}

function assertWalletAccount(actual: string | undefined, expected: string, hex = false) {
  const normalize = (value: string) => hex && /^0x[0-9a-f]+$/i.test(value)
    ? BigInt(value).toString(16) : value;
  if (!actual || !expected || normalize(actual) !== normalize(expected)) {
    throw new Error("Source wallet changed or cannot be verified. Reconnect and refresh the quote.");
  }
}

export async function executeSolanaUserSteps(userSteps: QuoteUserStep[], expectedAccount: string, solanaWalletId?: SolanaWalletId, onSubmitted?: (submission: SolanaSubmission) => void) {
  assertExternalPlan(userSteps, "SOLANA");
  const provider = getSolanaWalletProvider(solanaWalletId);

  if (!provider) {
    throw new Error("Selected Solana wallet is unavailable. Reconnect Backpack, Phantom, or a compatible wallet.");
  }

  const connection = getSolanaConnection();
  let lastSignature: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "SOLANA") {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step) as {
      encoding?: string;
      data?: string;
      serializedTransaction?: string;
      blockhash?: string;
      lastValidBlockHeight?: number;
    } | null;
    const transactionData = encoded?.serializedTransaction ?? encoded?.data;

    if (encoded?.encoding !== "base64" || typeof transactionData !== "string") {
      throw new Error("Unsupported Solana transaction payload.");
    }

    const versionedTransaction = VersionedTransaction.deserialize(base64ToBytes(transactionData));
    if (provider.publicKey?.toBase58() !== versionedTransaction.message.staticAccountKeys[0].toBase58())
      throw new Error("Solana wallet changed. Refresh the quote for the connected wallet.");
    const hasBlockhashContext = encoded.blockhash !== undefined || encoded.lastValidBlockHeight !== undefined;
    if (hasBlockhashContext) {
      if (encoded.blockhash !== versionedTransaction.message.recentBlockhash ||
          !Number.isSafeInteger(encoded.lastValidBlockHeight) || encoded.lastValidBlockHeight! <= 0) {
        throw new Error("Invalid Solana transaction validity context. Refresh the quote.");
      }
      if (provider.publicKey?.toBase58() !== versionedTransaction.message.staticAccountKeys[0].toBase58()) {
        throw new Error("Solana wallet changed. Refresh the quote for the connected wallet.");
      }
      if (!(await connection.isBlockhashValid(encoded.blockhash, { commitment: "confirmed" })).value) {
        throw new Error("Solana transaction expired. Refresh the quote.");
      }
    }

    const simulation = await connection.simulateTransaction(versionedTransaction, { sigVerify: false, commitment: "confirmed" });
    if (simulation.value.err) throw new Error(`Solana simulation failed: ${JSON.stringify(simulation.value.err)}`);
    assertWalletAccount(provider.publicKey?.toBase58(), expectedAccount);
    if (provider.publicKey?.toBase58() !== versionedTransaction.message.staticAccountKeys[0].toBase58())
      throw new Error("Solana wallet changed. Refresh the quote.");
    let submittedValidity: SolanaSubmission["validity"];
    if (provider.signAndSendTransaction) {
      // The wallet may rebuild the message before broadcasting. Its returned
      // signature is authoritative; the original blockhash is not.
      const result = await provider.signAndSendTransaction(versionedTransaction);

      if (!result.signature) {
        throw new Error("Solana wallet did not return a transaction signature.");
      }

      lastSignature = result.signature;
    } else if (provider.signTransaction) {
      const signedTransaction = await provider.signTransaction(versionedTransaction);

      if (hasBlockhashContext && signedTransaction.message.recentBlockhash === encoded.blockhash) {
        submittedValidity = { blockhash: encoded.blockhash!, lastValidBlockHeight: encoded.lastValidBlockHeight! };
      }
      lastSignature = await connection.sendRawTransaction(signedTransaction.serialize(), { preflightCommitment: "confirmed" });
    } else {
      throw new Error("The connected Solana wallet cannot sign transactions.");
    }

    const submission: SolanaSubmission = {
      signature: lastSignature,
      validity: submittedValidity,
    };
    onSubmitted?.(submission);
    await confirmSolanaSubmission(connection, submission);

    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable Solana user steps were found.");
  }

  return lastSignature;
}

export function checkSolanaSubmission(submission: SolanaSubmission) {
  return inspectSolanaSubmission(getSolanaConnection(), submission);
}

export async function executeAptosUserSteps(userSteps: QuoteUserStep[], expectedAccount: string, walletId?: string) {
  assertExternalPlan(userSteps, "APTOS");
  const provider = getAptosWalletProvider(walletId);

  if (!provider) {
    throw new Error("No Aptos wallet found. Install Petra or a compatible wallet.");
  }

  let lastHash: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "APTOS") {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step);

    if (!encoded) {
      throw new Error("Unsupported Aptos transaction payload.");
    }

    const aptosTransactionInput = getAptosTransactionInput(encoded);

    if (!aptosTransactionInput) {
      throw new Error("Unsupported Aptos transaction payload.");
    }

    assertWalletAccount((await provider.account?.())?.address, expectedAccount, true);
    const submissionResult =
      aptosTransactionInput.kind === "payload"
        ? await signAndSubmitAptosPayload(provider, aptosTransactionInput.value)
        : provider.signAndSubmitBCSTransaction
          ? await provider.signAndSubmitBCSTransaction(aptosTransactionInput.value)
          : provider.signAndSubmitTransaction
            ? await provider.signAndSubmitTransaction({
                serializedTransaction: bytesToBase64(aptosTransactionInput.value),
              })
            : (() => {
                throw new Error("The connected Aptos wallet cannot submit BCS transactions.");
              })();

    lastHash = getTransactionHash(submissionResult);
    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable Aptos user steps were found.");
  }

  return lastHash;
}

export async function executeTronUserSteps(userSteps: QuoteUserStep[], expectedAccount: string) {
  assertExternalPlan(userSteps, "TRON");
  const tronWeb = getTronWebProvider();

  if (!tronWeb?.trx) {
    throw new Error("No Tron wallet found. Install TronLink to continue.");
  }

  let lastHash: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "TRON") {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step);

    if (!encoded) {
      throw new Error("Unsupported Tron transaction payload.");
    }

    const tronTransactionInput = getTronTransactionInput(encoded);

    if (!tronTransactionInput) {
      throw new Error("Unsupported Tron transaction payload.");
    }

    assertWalletAccount(tronWeb.defaultAddress?.base58, expectedAccount);
    if (tronTransactionInput.kind === "object") {
      if (!tronWeb.trx.sign || !tronWeb.trx.sendRawTransaction) {
        throw new Error("The connected Tron wallet cannot sign transactions.");
      }

      const signedTransaction = await tronWeb.trx.sign(tronTransactionInput.value);
      const broadcastResult = await tronWeb.trx.sendRawTransaction(signedTransaction);

      if (broadcastResult.result === false) {
        throw new Error(broadcastResult.message ?? "Tron transaction broadcast failed.");
      }

      lastHash =
        getTransactionHash(signedTransaction) ??
        getTransactionHash(broadcastResult) ??
        lastHash;
      executedSteps += 1;
      continue;
    }

    if (!tronWeb.trx.sendHexTransaction) {
      throw new Error("The connected Tron wallet cannot broadcast hex transactions.");
    }

    const broadcastResult = await tronWeb.trx.sendHexTransaction(tronTransactionInput.value);

    if (broadcastResult.result === false) {
      throw new Error(broadcastResult.message ?? "Tron transaction broadcast failed.");
    }

    lastHash = getTransactionHash(broadcastResult) ?? lastHash;
    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable Tron user steps were found.");
  }

  return lastHash;
}

export async function executeStarknetUserSteps(userSteps: QuoteUserStep[], expectedAccount: string, walletId?: string) {
  assertExternalPlan(userSteps, "STARKNET");
  const provider = getStarknetWalletProvider(walletId);

  if (!provider) {
    throw new Error("No Starknet wallet found. Install Braavos or Argent X.");
  }

  let lastHash: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "STARKNET") {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step);

    if (!encoded) {
      throw new Error("Unsupported Starknet transaction payload.");
    }

    const calls = getStarknetTransactionInput(encoded);

    if (!calls?.length) {
      throw new Error("Unsupported Starknet transaction payload.");
    }

    assertWalletAccount(provider.selectedAddress ?? provider.account?.address, expectedAccount, true);
    if (provider.account?.execute) assertWalletAccount(provider.account.address, expectedAccount, true);
    const accountCalls = calls.map(toStarknetAccountCall);
    const executionResult =
      provider.account?.execute
        ? await provider.account.execute(accountCalls)
        : provider.request
          ? await provider.request({
              type: "wallet_addInvokeTransaction",
              params: { calls },
            })
          : (() => {
              throw new Error("The connected Starknet wallet cannot submit invoke transactions.");
            })();

    lastHash = getTransactionHash(executionResult) ?? lastHash;
    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable Starknet user steps were found.");
  }

  return lastHash;
}

async function executeSerializedMoveUserSteps(
  userSteps: QuoteUserStep[],
  chainType: BridgeChainType,
  chain: `${string}:${string}`,
  executeTransaction: SerializedMoveTransactionExecutor,
) {
  assertExternalPlan(userSteps, chainType);
  let lastHash: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== chainType) {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step);

    if (!encoded) {
      throw new Error(`Unsupported ${chainType} transaction payload.`);
    }

    const serializedTransaction = getSerializedMoveTransaction(encoded);

    if (!serializedTransaction) {
      throw new Error(`Unsupported ${chainType} transaction payload.`);
    }

    const result = await executeTransaction({
      transaction: serializedTransaction,
      chain,
    });

    const effects = (result as { effects?: { status?: { status?: string; error?: string } } } | null)?.effects;
    if (effects?.status?.status === "failure") throw new Error(effects.status.error ?? `${chainType} transaction failed.`);
    lastHash = getTransactionHash(result) ?? lastHash;
    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error(`No executable ${chainType} user steps were found.`);
  }

  return lastHash;
}

export async function executeSuiUserSteps(
  userSteps: QuoteUserStep[],
  executeTransaction: SerializedMoveTransactionExecutor,
) {
  return executeSerializedMoveUserSteps(
    userSteps,
    "SUI",
    "sui:mainnet",
    executeTransaction,
  );
}

export async function executeIotaMoveUserSteps(
  userSteps: QuoteUserStep[],
  executeTransaction: SerializedMoveTransactionExecutor,
) {
  return executeSerializedMoveUserSteps(
    userSteps,
    "IOTAMOVE",
    "iota:mainnet",
    executeTransaction,
  );
}

export async function executeTonUserSteps(
  userSteps: QuoteUserStep[],
  executeTransaction: TonTransactionExecutor,
) {
  assertExternalPlan(userSteps, "TON");
  let lastHash: string | undefined;
  let executedSteps = 0;

  for (const step of userSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "TON") {
      continue;
    }

    const encoded = getEncodedTransactionPayload(step);

    if (!encoded) {
      throw new Error("Unsupported TON transaction payload.");
    }

    const transactionRequest = getTonTransactionInput(encoded);

    if (!transactionRequest) {
      throw new Error("Unsupported TON transaction payload.");
    }

    const result = await executeTransaction(transactionRequest);
    lastHash = getTransactionHash(result) ?? lastHash;
    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable TON user steps were found.");
  }

  return lastHash;
}
