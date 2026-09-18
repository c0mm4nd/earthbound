import type { Address } from "viem";
import type { BridgeChain, BridgeToken, CustomOftConfig, LayerZeroOftListResponse } from "./bridge-types";
import { isSupportedCustomOftEndpointVersion, layerZeroOftV2Abi } from "./custom-oft";
import { buildDirectOftQuote, type DirectOftReader } from "./direct-oft";

export async function buildCustomOftQuote(args: {
  config: CustomOftConfig;
  srcChain: BridgeChain;
  dstChain: BridgeChain;
  amount: bigint;
  from: string;
  to: string;
  read: DirectOftReader;
}) {
  const { config, srcChain, dstChain, read } = args;
  if (!isSupportedCustomOftEndpointVersion(config.endpointVersion))
    throw new Error("Custom OFT requires Endpoint V2.");
  if (srcChain.chainType !== "EVM" || dstChain.chainType !== "EVM")
    throw new Error("Custom OFT requires two EVM chains.");
  const metadata: LayerZeroOftListResponse = { custom: [{ endpointVersion: "v2", deployments: {} }] };
  const tokens = await Promise.all([srcChain, dstChain].map(async (chain): Promise<BridgeToken> => {
    const deployment = config.deployments[chain.chainKey];
    if (!deployment) throw new Error("Missing custom OFT deployment.");
    const tokenAddress = deployment.tokenAddress || await read<Address>({
      chain, address: deployment.oftAddress as Address, abi: layerZeroOftV2Abi, functionName: "token",
    });
    metadata.custom[0].deployments![chain.chainKey] = { address: deployment.oftAddress, innerTokenAddress: tokenAddress };
    return { chainKey: chain.chainKey, address: tokenAddress, decimals: deployment.decimals, symbol: config.symbol, name: config.name };
  }));
  return buildDirectOftQuote({ ...args, metadata, srcToken: tokens[0], dstToken: tokens[1] });
}
