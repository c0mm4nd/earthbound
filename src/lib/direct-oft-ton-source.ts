// Browser-side DTO validation and adapter. TON SDK / RPC reads stay server-side.
import { tonOftTransfer } from "./direct-oft-ton-wire";
import type { Hex } from "viem";
import type { BridgeToken } from "./bridge-types";
import type { DirectOftAdapter } from "./direct-oft-types";
import type { ReceiveState } from "./direct-oft-receive";
import { nonEvmTokenMatches, tonAccount } from "./direct-oft-address";

export type TonSendRequest = { address: Hex; token: string; remoteEid: number; from: string; to: Hex; amountLD: string; checkBalance?: boolean };
export type TonSendQuote = ReceiveState & { amountLD: string; from: string; to: Hex; nativeFee: string; forward: string; value: string; jettonWallet: string; payload: string; receiveGas: string; validUntil: number };
export async function fetchTonSendQuote(body: TonSendRequest): Promise<TonSendQuote> {
  const response = await fetch("/api/bridge/oft-ton-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Failed to quote TON OFT send.");
  return data;
}
export async function createTonSourceAdapter(args: TonSendRequest & { selectedToken: BridgeToken; loadQuote?: (request: TonSendRequest) => Promise<TonSendQuote> }): Promise<DirectOftAdapter> {
  const { selectedToken, loadQuote, ...request } = args;
  const quote = await (loadQuote ?? fetchTonSendQuote)(request);
  const now = Math.floor(Date.now() / 1000);
  if (quote.addressBytes32.toLowerCase() !== args.address.toLowerCase() || !nonEvmTokenMatches("TON", quote.tokenAddress, args.token) ||
      quote.decimals !== 6 || quote.sharedDecimals !== 6 || selectedToken.decimals !== 6 || quote.amountLD !== args.amountLD ||
      tonAccount(quote.from) !== tonAccount(args.from) || quote.to.toLowerCase() !== args.to.toLowerCase() ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(quote.peer) || /^0x0{64}$/i.test(quote.peer) ||
      [quote.nativeFee, quote.forward, quote.value, quote.maxAmountLD, quote.receiveGas].some(v => typeof v !== "string" || !/^[1-9][0-9]{0,38}$/.test(v)) ||
      BigInt(quote.forward) <= BigInt(quote.nativeFee) || BigInt(quote.value) <= BigInt(quote.forward) || BigInt(quote.receiveGas) >= BigInt(1) << BigInt(128) ||
      !Number.isSafeInteger(quote.validUntil) || quote.validUntil <= now || quote.validUntil > now + 300 ||
      !quote.payload || quote.payload.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(quote.payload))
    throw new Error("TON send quote does not match the selected transfer.");
  tonAccount(quote.jettonWallet);
  const amount = BigInt(args.amountLD), fee = BigInt(quote.nativeFee);
  const payload = tonOftTransfer({ master: `0:${quote.tokenAddress.slice(2)}`, owner: quote.from, dstEid: args.remoteEid,
    to: args.to, amount, fee, forward: BigInt(quote.forward) }).toBoc().toString("base64");
  if (payload !== quote.payload) throw new Error("TON quote payload does not match the locally built transfer.");
  const guard = (p: Parameters<DirectOftAdapter["quoteSend"]>[0]) => {
    if (p.dstEid !== args.remoteEid || p.to.toLowerCase() !== args.to.toLowerCase() || p.amountLD !== amount ||
        (p.minAmountLD !== BigInt(0) && p.minAmountLD !== amount) || p.extraOptions !== "0x" || p.composeMsg !== "0x" || p.oftCmd !== "0x" ||
        Math.floor(Date.now() / 1000) >= quote.validUntil) throw new Error("TON send parameters changed or expired; refresh the quote.");
  };
  return { ...quote,
    // Normalized view of the actual TON enforced receive gas; the original cell
    // and all issuer options are retained by getLzSendMd for fees and sending.
    enforcedOptions: `0x000301001101${BigInt(quote.receiveGas).toString(16).padStart(32, "0")}`,
    quoteOft: async p => { guard(p); return { amountSentLD: amount, amountReceivedLD: amount, minAmountLD: BigInt(1), maxAmountLD: BigInt(quote.maxAmountLD) }; },
    quoteSend: async p => { guard(p); return { nativeFee: fee, lzTokenFee: BigInt(0) }; },
    buildSteps: async (p, f) => {
      guard(p);
      if (f.nativeFee !== fee || f.lzTokenFee !== BigInt(0)) throw new Error("TON fee changed; refresh the quote.");
      return [{ type: "TRANSACTION", chainKey: selectedToken.chainKey, chainType: "TON", description: "Send directly via TON OFT",
        transaction: { encoded: { from: quote.from, network: "-239", validUntil: quote.validUntil,
          messages: [{ address: quote.jettonWallet, amount: quote.value, payload }] } } }];
    },
  };
}
