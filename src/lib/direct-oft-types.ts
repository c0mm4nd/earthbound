import type { Hex } from "viem";
import type { TransactionUserStep } from "./bridge-types";
import type {
  LayerZeroMessagingFee,
  LayerZeroOftV2SendParam,
} from "./custom-oft";

export type DirectOftReceipt = {
  amountSentLD: bigint;
  amountReceivedLD: bigint;
  minAmountLD: bigint;
  maxAmountLD: bigint;
};

export interface DirectOftAdapter {
  addressBytes32: Hex;
  tokenAddress: string;
  decimals: number;
  sharedDecimals: number;
  amountEncoding?: "orderly-u256";
  peer: Hex;
  enforcedOptions: Hex;
  receiveOptions?: (recipient: string, enforcedOptions: Hex) => Promise<Hex>;
  validateReceive?: (recipient: string, amountLD: bigint) => Promise<void>;
  quoteOft: (params: LayerZeroOftV2SendParam) => Promise<DirectOftReceipt>;
  quoteSend: (
    params: LayerZeroOftV2SendParam,
  ) => Promise<LayerZeroMessagingFee>;
  buildSteps: (
    params: LayerZeroOftV2SendParam,
    fee: LayerZeroMessagingFee,
  ) => Promise<TransactionUserStep[]>;
}
