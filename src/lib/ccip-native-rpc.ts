import { createPublicClient, http, keccak256, parseAbi, toHex } from "viem";
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

export async function verifyCcipWrappedNative(chainIds: number[]) {
  const { CCIP_WRAPPED_NATIVE, WRAPPED_NATIVE_IMPLEMENTATION_SLOT, TAO_NATIVE_VAULT_ABI } = await import("./ccip-wrapped-native");
  await Promise.all([...new Set(chainIds)].map(async chainId => {
    const config = CCIP_WRAPPED_NATIVE[chainId];
    if (!config) throw new Error("This native wrapping deployment is not supported.");
    const client = createPublicClient({ transport: http(config.rpc, { timeout: 12_000, retryCount: 1 }) });
    const [actualChainId, code, implementation] = await Promise.all([client.getChainId(), client.getCode({ address: config.token }),
      client.getStorageAt({ address: config.token, slot: WRAPPED_NATIVE_IMPLEMENTATION_SLOT })]);
    if (actualChainId !== chainId || !code || keccak256(code) !== config.codeHash || implementation?.toLowerCase() !== config.implementation.toLowerCase()) throw new Error("Native wrapping deployment changed. Review is required before converting funds.");
    if (config.vault) {
      const [vaultCode, position, listed, paused] = await Promise.all([
        client.getCode({ address: config.vault.address }),
        client.readContract({ address: config.vault.address, abi: TAO_NATIVE_VAULT_ABI, functionName: "positionOf", args: [config.token] }),
        client.readContract({ address: config.vault.address, abi: TAO_NATIVE_VAULT_ABI, functionName: "isListed", args: [config.token] }),
        client.readContract({ address: config.vault.address, abi: TAO_NATIVE_VAULT_ABI, functionName: "isPaused" }),
      ]);
      if (!vaultCode || keccak256(vaultCode) !== config.vault.codeHash || position[1] !== BigInt(0) || !listed || paused) throw new Error("Native TAO's root staking vault is unavailable or its deployment changed.");
    }
    if (config.implementationHash) {
      const code = await client.getCode({ address: `0x${config.implementation.slice(-40)}` });
      if (!code || keccak256(code) !== config.implementationHash) throw new Error("Native wrapping implementation changed.");
    }
  }));
}

export class CcipNativeSourcePausedError extends Error {}
const CCIP_RISK_ABI = parseAbi([
  "function getArmProxy() view returns(address)",
  "function isCursed() view returns(bool)",
  "function isCursed(bytes16 subject) view returns(bool)",
]);
// Fee quotes alone do not prove a lane is available. Check the router's risk
// signal before asking the user to wrap, so paused lanes leave native funds alone.
export async function verifyCcipNativeSource(chainId: number, destinationSelector: string) {
  const { CCIP_WRAPPED_NATIVE } = await import("./ccip-wrapped-native");
  const config = CCIP_WRAPPED_NATIVE[chainId];
  if (!config) throw new Error("Unsupported native CCIP source.");
  const client = createPublicClient({ transport: http(config.rpc, { timeout: 12_000, retryCount: 1 }) });
  const risk = await client.readContract({ address: config.router, abi: CCIP_RISK_ABI, functionName: "getArmProxy" });
  const [globalPaused, lanePaused] = await Promise.all([
    client.readContract({ address: risk, abi: CCIP_RISK_ABI, functionName: "isCursed", args: [] }),
    client.readContract({ address: risk, abi: CCIP_RISK_ABI, functionName: "isCursed", args: [toHex(BigInt(destinationSelector), { size: 16 })] }),
  ]);
  if (globalPaused || lanePaused) throw new CcipNativeSourcePausedError(`CCIP transfers from ${config.symbol}'s network are temporarily paused. Native tokens have not been wrapped.`);
}
