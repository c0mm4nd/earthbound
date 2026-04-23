"use client";

import { IotaClient, getFullnodeUrl } from "@iota/iota-sdk/client";
import { IOTA_TYPE_ARG } from "@iota/iota-sdk/utils";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import { Connection, PublicKey, VersionedTransaction, clusterApiUrl } from "@solana/web3.js";
import type { BridgeChainType, QuoteUserStep, TransactionPayload } from "@/lib/bridge-types";
import { loadRpcConfig } from "@/lib/rpc-config";

type WalletConnectResult = {
  address: string;
  label: string;
};

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
  publicKey?: SolanaWalletPublicKey;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: SolanaWalletPublicKey }>;
  disconnect?(): Promise<void>;
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
    aptos?: AptosWalletProvider;
    tronLink?: TronLinkProvider;
    tronWeb?: TronWebProvider;
    starknet?: StarknetWalletProvider;
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
    "boc",
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

function getSolanaWalletProvider() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.phantom?.solana ?? window.solana ?? null;
}

function getSolanaConnection() {
  const solanaRpcUrl =
    loadRpcConfig()["solana"]?.[0] ?? clusterApiUrl("mainnet-beta");
  return new Connection(solanaRpcUrl, "confirmed");
}

function getSuiClient() {
  const suiRpcUrl = loadRpcConfig()["sui"]?.[0] ?? getJsonRpcFullnodeUrl("mainnet");
  return new SuiJsonRpcClient({ network: "mainnet", url: suiRpcUrl });
}

function getIotaClient() {
  const iotaRpcUrl = loadRpcConfig()["iota"]?.[0] ?? getFullnodeUrl("mainnet");
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

    if (calls.length) {
      return calls;
    }
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

  if (!address || !amount) {
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
  const directMessagesValue = Array.isArray(encoded.messages) ? encoded.messages : null;

  if (directMessagesValue) {
    const messages = directMessagesValue
      .map((message) => (isRecord(message) ? toTonMessage(message) : null))
      .filter(isDefined);

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

  try {
    return await provider.signAndSubmitTransaction(payload);
  } catch (error) {
    if ("payload" in payload) {
      throw error;
    }

    return provider.signAndSubmitTransaction({ payload });
  }
}

export async function connectExternalWallet(
  chainType: BridgeChainType | undefined | null,
): Promise<WalletConnectResult> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser.");
  }

  switch (chainType) {
    case "SOLANA": {
      const provider = getSolanaWalletProvider();

      if (!provider) {
        throw new Error("No Solana wallet found. Install Phantom or a compatible wallet.");
      }

      const result = await provider.connect();
      const address = result.publicKey?.toBase58() ?? provider.publicKey?.toBase58();

      if (!address) {
        throw new Error("Failed to read the connected Solana wallet address.");
      }

      return {
        address,
        label: provider.isPhantom ? "Phantom" : "Solana Wallet",
      };
    }
    case "APTOS": {
      const provider = window.aptos;

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
        label: "Aptos Wallet",
      };
    }
    case "TRON": {
      await window.tronLink?.request?.({ method: "tron_requestAccounts" });
      const address = getTronWebProvider()?.defaultAddress?.base58;

      if (!address) {
        throw new Error("No Tron wallet found. Install TronLink to continue.");
      }

      return {
        address,
        label: "TronLink",
      };
    }
    case "STARKNET": {
      if (!window.starknet) {
        throw new Error("No Starknet wallet found. Install Braavos or Argent X.");
      }

      const provider = window.starknet;
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
        label: "Starknet Wallet",
      };
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

export async function disconnectExternalWallet(chainType: BridgeChainType | undefined | null) {
  if (typeof window === "undefined") {
    return;
  }

  switch (chainType) {
    case "SOLANA":
      await getSolanaWalletProvider()?.disconnect?.();
      return;
    case "APTOS":
      await window.aptos?.disconnect?.();
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
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
      return tokenAccounts.value.reduce((total, accountInfo) => {
        const amount = getParsedTokenAmount(accountInfo);
        return amount === null ? total : total + BigInt(amount);
      }, BigInt(0));
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

export async function executeSolanaUserSteps(userSteps: QuoteUserStep[]) {
  const provider = getSolanaWalletProvider();

  if (!provider) {
    throw new Error("No Solana wallet found. Install Phantom or a compatible wallet.");
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
    } | null;

    if (encoded?.encoding !== "base64" || typeof encoded.data !== "string") {
      throw new Error("Unsupported Solana transaction payload.");
    }

    const versionedTransaction = VersionedTransaction.deserialize(base64ToBytes(encoded.data));

    if (provider.signAndSendTransaction) {
      const result = await provider.signAndSendTransaction(versionedTransaction);

      if (!result.signature) {
        throw new Error("Solana wallet did not return a transaction signature.");
      }

      lastSignature = result.signature;
    } else if (provider.signTransaction) {
      const signedTransaction = await provider.signTransaction(versionedTransaction);

      lastSignature = await connection.sendRawTransaction(signedTransaction.serialize());
    } else {
      throw new Error("The connected Solana wallet cannot sign transactions.");
    }

    const latestBlockhash = await connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: lastSignature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );

    executedSteps += 1;
  }

  if (!executedSteps) {
    throw new Error("No executable Solana user steps were found.");
  }

  return lastSignature;
}

export async function executeAptosUserSteps(userSteps: QuoteUserStep[]) {
  const provider = window.aptos;

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

export async function executeTronUserSteps(userSteps: QuoteUserStep[]) {
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

export async function executeStarknetUserSteps(userSteps: QuoteUserStep[]) {
  const provider = window.starknet;

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
