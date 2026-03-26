export type BridgeChainType =
  | "EVM"
  | "SOLANA"
  | "APTOS"
  | "TRON"
  | "STARKNET"
  | "TON"
  | "SUI"
  | "IOTAMOVE"
  | string;

export type BridgeApiProvider = "stargate" | "stargate-v2" | "layerzero";

export interface BridgeChain {
  name: string;
  shortName: string;
  chainKey: string;
  chainType: BridgeChainType;
  chainId: number;
  nativeCurrency: BridgeToken;
}

export interface BridgeToken {
  isSupported?: boolean;
  isBridgeable?: boolean;
  isVerified?: boolean;
  isPopular?: boolean;
  chainKey: string;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  icon?: string;
  price?: {
    usd?: number;
  };
}

export interface QuoteRouteStep {
  type: string;
  srcChainKey?: string;
  dstChainKey?: string;
}

export interface QuoteFee {
  type: string;
  amount?: string;
  amountUsd?: string;
  chainKey?: string;
  tokenAddress?: string;
}

export interface QuoteDuration {
  estimated?: string | null;
}

export interface TransactionPayload {
  to?: string;
  data?: `0x${string}`;
  value?: string;
  gasLimit?: string;
  serializedTransaction?: string;
  [key: string]: unknown;
}

export interface TransactionUserStep {
  type: "TRANSACTION";
  chainKey: string;
  chainType: string;
  description?: string;
  transaction: {
    encoded: TransactionPayload;
  };
}

export interface SignatureTypedDataField {
  name: string;
  type: string;
}

export interface SignatureUserStep {
  type: "SIGNATURE";
  chainKey: string;
  chainType: string;
  description?: string;
  signature: {
    typedData: {
      domain: Record<string, unknown>;
      types: Record<string, SignatureTypedDataField[]>;
      primaryType: string;
      message: Record<string, unknown>;
    };
  };
}

export interface UnsupportedUserStep {
  type: string;
  chainKey?: string;
  chainType?: string;
  description?: string;
  [key: string]: unknown;
}

export type QuoteUserStep =
  | TransactionUserStep
  | SignatureUserStep
  | UnsupportedUserStep;

export interface BridgeQuote {
  id: string;
  feeUsd?: string;
  feePercent?: string;
  srcAmount: string;
  dstAmount: string;
  dstAmountMin?: string;
  routeSteps: QuoteRouteStep[];
  userSteps: QuoteUserStep[];
  fees?: QuoteFee[];
  duration?: QuoteDuration;
}

export interface BridgeQuoteResponse {
  quotes: BridgeQuote[];
  rejectedQuotes?: Array<{
    error?: string;
  }>;
  tokens?: BridgeToken[];
}

export interface BuildUserStepsResponse {
  userSteps: QuoteUserStep[];
}

export interface BridgeStatusResponse {
  status: string;
  explorerUrl?: string;
  substatus?: string;
  error?: string;
}

export interface CustomOftDeployment {
  chainKey: string;
  oftAddress: string;
  tokenAddress?: string;
  decimals: number;
  approvalRequired?: boolean;
  type?: string;
}

export interface CustomOftConfig {
  id: string;
  name: string;
  symbol: string;
  endpointVersion?: string;
  deployments: Record<string, CustomOftDeployment>;
}

export interface LayerZeroOftTransferResponse {
  transactionData?: {
    populatedTransaction?: TransactionPayload | string;
    approvalTransaction?: TransactionPayload | null;
  };
}

export interface LayerZeroOftListDeployment {
  address: string;
  localDecimals?: number;
  sharedDecimals?: number;
  innerTokenAddress?: string;
  approvalRequired?: boolean;
  type?: string;
}

export interface LayerZeroOftListEntry {
  name?: string;
  symbol?: string;
  sharedDecimals?: number;
  endpointVersion?: string;
  deployments?: Record<string, LayerZeroOftListDeployment>;
}

export type LayerZeroOftListResponse = Record<string, LayerZeroOftListEntry[]>;
