import type { Hex } from "viem";
import type { BridgeToken } from "./bridge-types";
import type { DirectOftAdapter } from "./direct-oft-types";
import { nonEvmRecipient, nonEvmTokenMatches } from "./direct-oft-address";

export const DIRECT_OFT_RECEIVE_TYPES = ["APTOS", "STARKNET", "TRON", "SUI", "STELLAR", "TON"] as const;
export type ReceiveStateRequest = { chainType: string; address: Hex; token: string; remoteEid: number; recipient: string; amountLD?: string };
export type ReceiveState = { addressBytes32: Hex; tokenAddress: string; decimals: number; sharedDecimals: number; peer: Hex; maxAmountLD: string };

export async function fetchNonEvmReceiveState(body: ReceiveStateRequest): Promise<ReceiveState> {
  const response = await fetch("/api/bridge/oft-receive-state", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Failed to validate destination OFT.");
  return data as ReceiveState;
}

export async function createNonEvmReceiveAdapter(args: ReceiveStateRequest & {
  selectedToken: BridgeToken;
  loadState?: (request: ReceiveStateRequest) => Promise<ReceiveState>;
}): Promise<DirectOftAdapter> {
  nonEvmRecipient(args.chainType, args.recipient);
  const { chainType, address, token, remoteEid, recipient } = args;
  const request = { chainType, address, token, remoteEid, recipient };
  const loadState = args.loadState ?? fetchNonEvmReceiveState;
  const state = await loadState(request);
  if (state.addressBytes32.toLowerCase() !== address.toLowerCase() ||
    !nonEvmTokenMatches(chainType, state.tokenAddress, token) ||
    state.decimals !== args.selectedToken.decimals || !/^0x[0-9a-f]{64}$/i.test(state.peer) ||
    !Number.isInteger(state.sharedDecimals) || state.sharedDecimals < 0 || state.sharedDecimals > state.decimals ||
    !/^\d+$/.test(state.maxAmountLD)) throw new Error("Destination OFT configuration does not match the selected asset.");
  const receiveOnly = async (): Promise<never> => { throw new Error(`${chainType} direct OFT currently supports receiving from EVM only.`); };
  return {
    ...state, enforcedOptions: "0x",
    validateReceive: async (to, amount) => {
      if (nonEvmRecipient(chainType, to) !== nonEvmRecipient(chainType, recipient)) throw new Error("Recipient changed; refresh the quote.");
      if (amount > BigInt(state.maxAmountLD)) throw new Error("Amount exceeds the destination OFT receive capacity.");
      if (chainType === "STELLAR") {
        const fresh = await loadState({ ...request, amountLD: amount.toString() });
        if (fresh.addressBytes32 !== state.addressBytes32 || fresh.peer !== state.peer ||
          fresh.tokenAddress !== state.tokenAddress || fresh.decimals !== state.decimals || fresh.sharedDecimals !== state.sharedDecimals ||
          amount > BigInt(fresh.maxAmountLD)) throw new Error("Stellar receive configuration changed; refresh the quote.");
      }
    },
    quoteOft: receiveOnly, quoteSend: receiveOnly, buildSteps: receiveOnly,
  };
}
