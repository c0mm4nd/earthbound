import { encodeAbiParameters, encodeFunctionData, erc20Abi, isAddress, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import type { BridgeChain, BridgeQuote } from "./bridge-types";
import { ccipAddressKey, isCcipAddress } from "./ccip-addresses";
import { CCIP_WRAPPED_NATIVE, nativeConversionTransaction } from "./ccip-wrapped-native";
import { CCIP_NATIVE_NETWORKS, CCIP_NATIVE_EXTRA_ARGS, isCcipNative } from "./ccip-native";
import { ccipMessageEncoding } from "./ccip-message";
import type { CcipQuoteRequest } from "./ccip";

// IRouterClient/EtherSenderReceiver EVM2AnyMessage. Token routes have no callback;
// native ETH routes call the reviewed destination wrapper to unwrap.
// https://docs.chain.link/ccip/evm/concepts/best-practices
export const CCIP_ROUTER_ABI = parseAbi([
  "struct TokenAmount { address token; uint256 amount; }",
  "struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }",
  "function getFee(uint64 destinationChainSelector, Message message) view returns (uint256)",
  "function ccipSend(uint64 destinationChainSelector, Message message) payable returns (bytes32)",
]);
export const CCIP_EXTRA_ARGS = `0x181dcf10${encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [BigInt(0), true]).slice(2)}` as Hex;

function uint(value: string, bits = 256) {
  if (!/^\d{1,78}$/.test(value) || BigInt(value) >= BigInt(2) ** BigInt(bits)) throw new Error("Invalid CCIP transaction amount or selector.");
  return BigInt(value);
}
const same = (a: string, b: string) => ccipAddressKey(a) === ccipAddressKey(b);

export function assertCcipQuote(quote: BridgeQuote, request: CcipQuoteRequest, chain: BridgeChain) {
  const c = quote.ccip;
  if (c?.wrapping) {
    const source = CCIP_WRAPPED_NATIVE[chain.chainId];
    const destination = CCIP_WRAPPED_NATIVE[c.wrapping.destinationChainId];
    if (c.native || (!c.wrapping.source && !c.wrapping.destination) ||
        Boolean(c.wrapping.source) !== (chain.chainType === "EVM" && isCcipNative(c.sourceToken)) ||
        Boolean(c.wrapping.destination) !== (c.destinationFamily === "EVM" && isCcipNative(c.destinationToken)) ||
        (c.wrapping.source && (!source || !same(source.token, c.wrapping.source) || source.selector !== c.sourceSelector || !same(source.router, c.router))) ||
        (c.wrapping.destination && (!destination || !same(destination.token, c.wrapping.destination) || destination.selector !== c.destinationSelector))) {
      throw new Error("CCIP native wrapping does not match the reviewed asset.");
    }
  }
  if (c && (c.native || (!c.wrapping && (isCcipNative(c.sourceToken) || isCcipNative(c.destinationToken))))) {
    const source = CCIP_NATIVE_NETWORKS[chain.chainId];
    const destination = Object.values(CCIP_NATIVE_NETWORKS).find(config => config.selector === c.destinationSelector);
    if (!c.native || chain.chainType !== "EVM" || c.destinationFamily !== "EVM" || !source || !destination ||
        source.selector !== c.sourceSelector || !same(c.router, source.wrapper) ||
        !same(c.native.destinationWrapper, destination.wrapper) || !same(c.native.sourceWrappedToken, source.wrappedToken) ||
        !same(c.native.destinationWrappedToken, destination.wrappedToken) || !isCcipNative(c.sourceToken) || !isCcipNative(c.destinationToken) ||
        !isCcipAddress("EVM", request.srcWalletAddress ?? "") || !same(request.srcWalletAddress!, c.receiver)) {
      throw new Error("Native CCIP quote does not match the supported wrapper and source wallet recipient.");
    }
  }
  if (quote.provider !== "ccip" || !c || (c.sourceFamily ?? "EVM") !== chain.chainType || c.sourceChainId !== chain.chainId ||
      request.srcChainKey !== chain.chainKey || quote.srcAmount !== request.amount ||
      !same(c.sourceToken, request.srcTokenAddress) || !same(c.destinationToken, request.dstTokenAddress) || !same(c.receiver, request.dstWalletAddress) ||
      quote.routeSteps.length !== 1 || quote.routeSteps[0].type !== "CCIP" ||
      quote.routeSteps[0].srcChainKey !== request.srcChainKey || quote.routeSteps[0].dstChainKey !== request.dstChainKey ||
      !isCcipAddress(chain.chainType, c.router) || !((c.native || c.wrapping?.source) ? isCcipNative(c.sourceToken) : isCcipAddress(chain.chainType, c.sourceToken)) ||
      !isCcipAddress(c.destinationFamily ?? "EVM", c.receiver) || !((c.native || c.wrapping?.destination) ? isCcipNative(c.destinationToken) : isCcipAddress(c.destinationFamily ?? "EVM", c.destinationToken)) ||
      uint(c.sourceSelector, 64) === BigInt(0) || uint(c.destinationSelector, 64) === BigInt(0) || c.sourceSelector === c.destinationSelector ||
      uint(quote.srcAmount) === BigInt(0) || uint(quote.dstAmount) === BigInt(0) || uint(c.maxNativeFee) < uint(c.nativeFee) ||
      uint(c.maxNativeFee) > (uint(c.nativeFee) * BigInt(101) + BigInt(99)) / BigInt(100) || !Number.isFinite(c.quotedAt)) {
    throw new Error("CCIP quote does not match the reviewed transfer.");
  }
}

export function ccipMessage(quote: BridgeQuote) {
  if (!quote.ccip) throw new Error("Missing CCIP execution data.");
  if (quote.ccip.native) return {
    receiver: encodeAbiParameters([{ type: "address" }], [quote.ccip.native.destinationWrapper as Address]),
    data: "0x" as Hex, tokenAmounts: [{ token: zeroAddress, amount: BigInt(quote.srcAmount) }],
    feeToken: zeroAddress, extraArgs: CCIP_NATIVE_EXTRA_ARGS,
  };
  return {
    ...ccipMessageEncoding(quote.ccip.sourceFamily ?? "EVM", quote.ccip.destinationFamily ?? "EVM", quote.ccip.receiver),
    data: "0x" as Hex,
    tokenAmounts: [{ token: (quote.ccip.wrapping?.source ?? quote.ccip.sourceToken) as Address, amount: BigInt(quote.srcAmount) }],
    feeToken: zeroAddress,
  };
}

export type CcipTransaction = { to: Address; data: Hex; value: bigint };

// Hedera getFee uses tinybars (8 decimals), while its JSON-RPC transaction value
// uses 18 decimals. https://docs.chain.link/ccip/v1/evm/api-reference/v1.6.0/i-router-client
export function ccipTransactionValue(chainId: number, fee: bigint) {
  const value = chainId === 295 ? fee * BigInt(10) ** BigInt(10) : fee;
  if (value < BigInt(0) || value >= BigInt(2) ** BigInt(256)) throw new Error("Invalid CCIP native fee.");
  return value;
}
type Dependencies = {
  assertContext: () => void;
  refresh: () => Promise<BridgeQuote>;
  read: (args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; account?: Address }) => Promise<bigint>;
  send: (tx: CcipTransaction, kind: "approval" | "bridge" | "wrap") => Promise<string>;
  wait: (hash: string, kind: "approval" | "bridge" | "wrap") => Promise<string>;
  submitted: (hash: string, confirmed: boolean) => void;
  wrapped?: (hash: string, confirmed: boolean) => void;
  step: (description: string) => void;
};

// No upstream calldata is signed. Build exact ERC20 approvals or atomic native
// wrapping, and ccipSend locally.
export async function executeCcipTransfer(quote: BridgeQuote, request: CcipQuoteRequest, chain: BridgeChain, sender: string, deps: Dependencies) {
  assertCcipQuote(quote, request, chain);
  if (chain.chainType !== "EVM") throw new Error("Use the source family CCIP executor.");
  if (!isAddress(sender) || same(sender, zeroAddress)) throw new Error("Connect a valid source wallet.");
  const reviewed = quote.ccip!;
  if (reviewed.native && !same(sender, reviewed.receiver)) throw new Error("Native CCIP can only send to the source wallet's same address on the destination network.");
  const refresh = async () => {
    deps.assertContext();
    const fresh = await deps.refresh();
    deps.assertContext();
    assertCcipQuote(fresh, request, chain);
    const c = fresh.ccip!;
    if (JSON.stringify(c.wrapping) !== JSON.stringify(reviewed.wrapping) || Boolean(c.native) !== Boolean(reviewed.native) || !same(c.router, reviewed.router) || c.sourceSelector !== reviewed.sourceSelector || c.destinationSelector !== reviewed.destinationSelector ||
        BigInt(fresh.dstAmount) < BigInt(quote.dstAmount) || BigInt(c.nativeFee) > BigInt(reviewed.maxNativeFee) ||
        Date.now() - c.quotedAt > 120_000 || c.quotedAt > Date.now() + 5_000) {
      throw new Error("CCIP quote changed. Refresh and review the new quote before sending.");
    }
    return fresh;
  };
  await refresh();
  const amount = BigInt(request.amount);
  const sourceToken = (reviewed.wrapping?.source ?? reviewed.sourceToken) as Address;
  if (reviewed.wrapping?.source) {
    if (!deps.wrapped) throw new Error("Wrapping submission tracking is required.");
    const balanceArgs = { address: sourceToken, abi: erc20Abi, functionName: "balanceOf", args: [sender] };
    const before = await deps.read(balanceArgs);
    deps.assertContext();
    deps.step("Wrapping native tokens before CCIP transfer");
    const hash = await deps.send(nativeConversionTransaction(chain.chainId, sourceToken, request.amount, "wrap"), "wrap");
    deps.wrapped(hash, false);
    const confirmed = await deps.wait(hash, "wrap");
    deps.wrapped(confirmed, true);
    deps.assertContext();
    if (await deps.read(balanceArgs) - before !== amount) throw new Error("Wrapped balance did not increase by the reviewed amount. Check the wrapping transaction before continuing.");
  }
  const allowanceArgs = { address: sourceToken, abi: erc20Abi, functionName: "allowance", args: [sender, reviewed.router] };
  const allowance = reviewed.native ? amount : await deps.read(allowanceArgs);
  deps.assertContext();
  if (allowance < amount) {
    // USDT and similar tokens require resetting a nonzero insufficient allowance.
    for (const value of allowance > BigInt(0) ? [BigInt(0), amount] : [amount]) {
      deps.step(value === BigInt(0) ? "Resetting token allowance" : "Approving transfer amount");
      deps.assertContext();
      const hash = await deps.send({ to: sourceToken, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reviewed.router as Address, value] }) }, "approval");
      await deps.wait(hash, "approval");
      deps.assertContext();
    }
  }
  deps.step("Checking CCIP fee and transfer amount");
  const fresh = await refresh();
  if (!reviewed.native && await deps.read(allowanceArgs) < amount) throw new Error("Token approval was not applied. Check the approval transaction.");
  // Final read verifies the exact message's current fee, including after slow approvals.
  const message = ccipMessage(fresh);
  const args = [BigInt(reviewed.destinationSelector), message] as const;
  const fee = await deps.read({ address: reviewed.router as Address, abi: CCIP_ROUTER_ABI, functionName: "getFee", args, account: sender as Address });
  if (fee < BigInt(0) || fee > BigInt(reviewed.maxNativeFee)) throw new Error("CCIP fee increased. Refresh and review the new quote before sending.");
  deps.assertContext();
  deps.step("Sending CCIP transfer");
  const hash = await deps.send({ to: reviewed.router as Address, data: encodeFunctionData({ abi: CCIP_ROUTER_ABI, functionName: "ccipSend", args }), value: ccipTransactionValue(chain.chainId, fee + (reviewed.native ? amount : BigInt(0))) }, "bridge");
  deps.submitted(hash, false);
  const confirmedHash = await deps.wait(hash, "bridge");
  deps.submitted(confirmedHash, true);
  return confirmedHash;
}
