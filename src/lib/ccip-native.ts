import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import type { CcipChain } from "./ccip";

// Transporter's EtherSenderReceiver 1.5.0 deployments, checked 2026-10-12.
// Verified source: https://etherscan.io/address/0x66598216d8e4d9afe0f06d525b335b762229842f#code
// The immutable wrapper encodes msg.sender as the final recipient. Never offer
// an arbitrary recipient or treat the destination wrapper as the user's address.
export const CCIP_NATIVE_NETWORKS: Record<number, {
  selector: string; wrapper: Address; wrappedToken: Address; router: Address; codeHash: Hex; rpc: string;
}> = {
  1: { selector: "5009297550715157269", wrapper: "0x66598216d8e4d9afe0f06d525b335b762229842f", wrappedToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", router: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d", codeHash: "0x34b8d571d30af3499c997f351cdaf5fb26648ffcacfcbd81e729a498812f21b2", rpc: "https://ethereum-rpc.publicnode.com" },
  10: { selector: "3734403246176062136", wrapper: "0x66598216d8e4d9afe0f06d525b335b762229842f", wrappedToken: "0x4200000000000000000000000000000000000006", router: "0x3206695cae29952f4b0c22a169725a865bc8ce0f", codeHash: "0xc6cbe8da1fcf7d63fac5a524cd618d89411806539aa4a3b7229ea1dfca346dbb", rpc: "https://optimism-rpc.publicnode.com" },
  42161: { selector: "4949039107694359620", wrapper: "0x66598216d8e4d9afe0f06d525b335b762229842f", wrappedToken: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", router: "0x141fa059441e0ca23ce184b6a78bafd2a517dde8", codeHash: "0x3c7a3016eb6dacec8362fd6578c7b76e5bf359f6aa19a34c7ea25a977cb38e73", rpc: "https://arbitrum-one-rpc.publicnode.com" },
  8453: { selector: "15971525489660198786", wrapper: "0x696c73976ba5d4064a4639c5911b42130f4869fb", wrappedToken: "0x4200000000000000000000000000000000000006", router: "0x881e3a65b4d4a04dd529061dd0071cf975f58bcd", codeHash: "0x211f33cc73f6c5b0a1189d1efbe483a074f3bde9912f00bb54dda5c4d49b7b3c", rpc: "https://base-rpc.publicnode.com" },
};
export const isCcipNative = (address: string) => [zeroAddress, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"].includes(address.toLowerCase());
export const CCIP_NATIVE_EXTRA_ARGS = `0x181dcf10${encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [BigInt(100_000), true]).slice(2)}` as Hex;
export function ccipNativeNetwork(chain: CcipChain) {
  const config = chain.chainType === "EVM" ? CCIP_NATIVE_NETWORKS[chain.chainId] : undefined;
  return config && config.selector === chain.ccip.selector && config.router === chain.ccip.router.toLowerCase() &&
    chain.nativeCurrency.symbol === "ETH" && chain.nativeCurrency.decimals === 18 ? config : undefined;
}
