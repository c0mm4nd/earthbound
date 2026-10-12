import { CCTP_EVM } from "./cctp-evm";
import { CCTP_NETWORKS } from "./cctp-networks";
import { isCctpUsdc } from "./cctp";
import type { BridgeToken } from "./bridge-types";

export const CCTP_CHAINS = CCTP_NETWORKS.map(network => ({ ...network,
  chainKey: CCTP_EVM.find(c => c.domain === network.domain)?.chainKey ?? network.family.toLowerCase(),
}));
export const cctpForKey = (key: string) => CCTP_CHAINS.find(c => c.chainKey === key);
export function supportsCctpPair(source: BridgeToken | null, destination: BridgeToken | null) {
  const src = source && cctpForKey(source.chainKey), dst = destination && cctpForKey(destination.chainKey);
  return Boolean(src && dst && src.domain !== dst.domain && isCctpUsdc(src, source!.address) && isCctpUsdc(dst, destination!.address));
}
export function cctpAccountEqual(a: string, b: string) {
  return a.startsWith("0x") && b.startsWith("0x") ? BigInt(a) === BigInt(b) : a === b;
}
export function cctpNativeTransferKey(t: { sourceDomain: number; destinationDomain: number; sender: string; recipient: string; amount: string }) {
  const key = (s: string) => /^0x[\da-f]+$/i.test(s) ? BigInt(s).toString(16) : s;
  return JSON.stringify([t.sourceDomain, t.destinationDomain, key(t.sender), key(t.recipient), t.amount]);
}
