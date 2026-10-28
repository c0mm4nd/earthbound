import type { Address } from "viem";
import type { BridgeChain, BridgeToken } from "./bridge-types";

export type StargateDeployment = {
  chainKey: string;
  chainId: number;
  asset: "USDC" | "USDT";
  token: Address;
  address: Address;
  messaging: Address;
  type: 0 | 1; // Pool | Hydra OFT
};

// Official deployments, pinned for review. Runtime reads verify token identity,
// reciprocal messaging peers, asset mappings, status, decimals and liquidity.
// https://github.com/stargate-protocol/stargate-v2/tree/2d09374b9139ff788ae63319ad4080f80a4c4af5/packages/stg-evm-v2/deployments
// ERC-20 USDC/USDT only; native assets and bus/compose routes are not registered.
export const STARGATE_DEPLOYMENTS: readonly StargateDeployment[] = [
  {"chainKey":"ethereum","chainId":1,"asset":"USDC","token":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","address":"0xc026395860Db2d07ee33e05fE50ed7bD583189C7","messaging":"0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980","type":0},
  {"chainKey":"ethereum","chainId":1,"asset":"USDT","token":"0xdAC17F958D2ee523a2206206994597C13D831ec7","address":"0x933597a323Eb81cAe705C5bC29985172fd5A3973","messaging":"0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980","type":0},
  {"chainKey":"flow","chainId":747,"asset":"USDC","token":"0xF1815bd50389c46847f0Bda824eC8da914045D14","address":"0xAF54BE5B6eEc24d6BFACf1cce4eaF680A8239398","messaging":"0x45A01E4e04F14f7A4a6702c74187c5F6222033cd","type":1},
  {"chainKey":"flow","chainId":747,"asset":"USDT","token":"0x674843C06FF83502ddb4D37c2E09C01cdA38cbc8","address":"0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6","messaging":"0x45A01E4e04F14f7A4a6702c74187c5F6222033cd","type":1},
  {"chainKey":"bera","chainId":80094,"asset":"USDC","token":"0x549943e04f40284185054145c6E4e9568C1D3241","address":"0xAF54BE5B6eEc24d6BFACf1cce4eaF680A8239398","messaging":"0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6","type":1},
  {"chainKey":"arbitrum","chainId":42161,"asset":"USDC","token":"0xaf88d065e77c8cc2239327c5edb3a432268e5831","address":"0xe8CDF27AcD73a434D661C84887215F7598e7d0d3","messaging":"0x19cFCE47eD54a88614648DC3f19A5980097007dD","type":0},
  {"chainKey":"arbitrum","chainId":42161,"asset":"USDT","token":"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9","address":"0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0","messaging":"0x19cFCE47eD54a88614648DC3f19A5980097007dD","type":0},
  {"chainKey":"base","chainId":8453,"asset":"USDC","token":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","address":"0x27a16dc786820B16E5c9028b75B99F6f604b5d26","messaging":"0x5634c4a5FEd09819E3c46D86A965Dd9447d86e47","type":0},
  {"chainKey":"optimism","chainId":10,"asset":"USDC","token":"0x0b2c639c533813f4aa9d7837caf62653d097ff85","address":"0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0","messaging":"0xF1fCb4CBd57B67d683972A59B6a7b1e2E8Bf27E6","type":0},
  {"chainKey":"optimism","chainId":10,"asset":"USDT","token":"0x94b008aa00579c1307b0ef2c499ad98a8ce58e58","address":"0x19cFCE47eD54a88614648DC3f19A5980097007dD","messaging":"0xF1fCb4CBd57B67d683972A59B6a7b1e2E8Bf27E6","type":0},
  {"chainKey":"avalanche","chainId":43114,"asset":"USDC","token":"0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E","address":"0x5634c4a5FEd09819E3c46D86A965Dd9447d86e47","messaging":"0x17E450Be3Ba9557F2378E20d64AD417E59Ef9A34","type":0},
  {"chainKey":"avalanche","chainId":43114,"asset":"USDT","token":"0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7","address":"0x12dC9256Acc9895B076f6638D628382881e62CeE","messaging":"0x17E450Be3Ba9557F2378E20d64AD417E59Ef9A34","type":0},
  {"chainKey":"polygon","chainId":137,"asset":"USDC","token":"0x3c499c542cef5e3811e1192ce70d8cc03d5c3359","address":"0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4","messaging":"0x6CE9bf8CDaB780416AD1fd87b318A077D2f50EaC","type":0},
  {"chainKey":"polygon","chainId":137,"asset":"USDT","token":"0xc2132d05d31c914a87c6611c10748aeb04b58e8f","address":"0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7","messaging":"0x6CE9bf8CDaB780416AD1fd87b318A077D2f50EaC","type":0},
];

export function findStargateRoute(srcChain: BridgeChain, dstChain: BridgeChain, srcToken: BridgeToken, dstToken: BridgeToken) {
  if (srcChain.chainType !== "EVM" || dstChain.chainType !== "EVM" || srcChain.chainId === dstChain.chainId) return null;
  const find = (chain: BridgeChain, token: BridgeToken) => token.chainKey === chain.chainKey
    ? STARGATE_DEPLOYMENTS.find(d => d.chainKey === chain.chainKey && d.chainId === chain.chainId && d.token.toLowerCase() === token.address.toLowerCase())
    : undefined;
  const source = find(srcChain, srcToken);
  const destination = find(dstChain, dstToken);
  return source && destination && source.asset === destination.asset ? { source, destination } : null;
}
