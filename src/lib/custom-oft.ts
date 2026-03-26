import {
  type Chain,
  ChainKey,
  EndpointId,
  EndpointVersion,
  Stage,
  chainAndStageToEndpointId,
} from "@layerzerolabs/lz-definitions";
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  padHex,
  parseAbi,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { BridgeChainType, TransactionPayload } from "@/lib/bridge-types";

const CUSTOM_OFT_DEFAULT_EVM_GAS_LIMIT = BigInt(65_000);
const LAYERZERO_V2_ENDPOINT_ID_OVERRIDES: Record<string, number> = {
  beam: EndpointId.MERITCIRCLE_V2_MAINNET,
  linea: EndpointId.ZKCONSENSYS_V2_MAINNET,
  zkevm: EndpointId.ZKPOLYGON_V2_MAINNET,
};

export const layerZeroOftV2Abi = parseAbi([
  "function approvalRequired() view returns (bool)",
  "function token() view returns (address)",
  "function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD), (int256 feeAmountLD, string description)[] oftFeeDetails, (uint256 amountSentLD, uint256 amountReceivedLD))",
  "function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))",
  "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, (uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee), (uint256 amountSentLD, uint256 amountReceivedLD))",
]);

export type LayerZeroOftV2SendParam = {
  dstEid: number;
  to: Hex;
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions: Hex;
  composeMsg: Hex;
  oftCmd: Hex;
};

export type LayerZeroMessagingFee = {
  nativeFee: bigint;
  lzTokenFee: bigint;
};

export function getLayerZeroV2EndpointId(chainKey: string) {
  if (chainKey in LAYERZERO_V2_ENDPOINT_ID_OVERRIDES) {
    return LAYERZERO_V2_ENDPOINT_ID_OVERRIDES[chainKey] ?? null;
  }

  const resolvedChainKey = ChainKey[
    chainKey.toUpperCase() as keyof typeof ChainKey
  ] as unknown as Chain | undefined;

  if (!resolvedChainKey) {
    return null;
  }

  try {
    return chainAndStageToEndpointId(resolvedChainKey, Stage.MAINNET, EndpointVersion.V2);
  } catch {
    return null;
  }
}

export function isLocalCustomOftSourceChainSupported(chainType?: BridgeChainType | null) {
  return chainType === "EVM";
}

export function isLocalCustomOftDestinationChainSupported(
  chainType?: BridgeChainType | null,
  chainKey?: string | null,
) {
  return chainType === "EVM" && Boolean(chainKey && getLayerZeroV2EndpointId(chainKey));
}

export function isSupportedCustomOftEndpointVersion(endpointVersion?: string | null) {
  const normalizedEndpointVersion = endpointVersion?.trim().toLowerCase();
  return !normalizedEndpointVersion || normalizedEndpointVersion === "v2";
}

export function buildLayerZeroExecutorLzReceiveOption(
  gasLimit: bigint,
  nativeDrop = BigInt(0),
) {
  const params =
    nativeDrop > BigInt(0)
      ? encodePacked(["uint128", "uint128"], [gasLimit, nativeDrop])
      : encodePacked(["uint128"], [gasLimit]);

  return concatHex([
    toHex(3, { size: 2 }),
    encodePacked(["uint8", "uint16", "uint8", "bytes"], [1, size(params) + 1, 1, params]),
  ]);
}

export function buildDefaultCustomOftExtraOptions(chainType?: BridgeChainType | null) {
  if (chainType !== "EVM") {
    throw new Error("Local custom OFT execution currently supports EVM destination chains only.");
  }

  return buildLayerZeroExecutorLzReceiveOption(CUSTOM_OFT_DEFAULT_EVM_GAS_LIMIT);
}

export function buildCustomOftRecipientBytes32(
  chainType: BridgeChainType | undefined | null,
  address: string,
) {
  if (chainType !== "EVM") {
    throw new Error("Local custom OFT execution currently supports EVM destination chains only.");
  }

  return padHex(address as Hex, { size: 32 });
}

export function buildCustomOftApprovalTransaction(
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
): TransactionPayload {
  return {
    to: tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spenderAddress as Address, amount],
    }),
    value: "0",
  };
}

export function buildCustomOftSendTransaction(
  oftAddress: string,
  sendParam: LayerZeroOftV2SendParam,
  fee: LayerZeroMessagingFee,
  refundAddress: string,
): TransactionPayload {
  return {
    to: oftAddress,
    data: encodeFunctionData({
      abi: layerZeroOftV2Abi,
      functionName: "send",
      args: [sendParam, fee, refundAddress as Address],
    }),
    value: fee.nativeFee.toString(),
  };
}
