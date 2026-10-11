import { createPublicClient, http, keccak256 } from "viem";
import { CCIP_NATIVE_NETWORKS } from "./ccip-native";

// Fixed public hosts, never URLs supplied by a quote request. Validate both
// immutable wrapper deployments before exposing a sendable native quote.
export async function verifyCcipNativeDeployments(sourceChainId: number, destinationChainId: number) {
  await Promise.all([sourceChainId, destinationChainId].map(async chainId => {
    const config = CCIP_NATIVE_NETWORKS[chainId];
    if (!config) throw new Error("Native CCIP is unavailable on this network.");
    const client = createPublicClient({ transport: http(config.rpc, { timeout: 12_000, retryCount: 1 }) });
    const [actualChainId, code] = await Promise.all([client.getChainId(), client.getCode({ address: config.wrapper })]);
    if (actualChainId !== chainId || !code || keccak256(code) !== config.codeHash) {
      throw new Error("Native CCIP deployment changed. This route is unavailable until reviewed.");
    }
  }));
}
