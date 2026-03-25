export interface BridgeChain {
  name: string;
  shortName: string;
  chainKey: string;
  chainType: string;
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
  to: string;
  data?: `0x${string}`;
  value?: string;
  gasLimit?: string;
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

export interface BridgeStatusResponse {
  status: string;
  explorerUrl?: string;
  substatus?: string;
  error?: string;
}
