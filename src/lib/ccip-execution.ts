import { encodeAbiParameters, encodeFunctionData, erc20Abi, isAddress, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import type { BridgeChain, BridgeQuote } from "./bridge-types";
import { ccipAddressKey, isCcipAddress } from "./ccip-addresses";
import { ccipMessageEncoding } from "./ccip-message";
import type { CcipQuoteRequest } from "./ccip";

// IRouterClient's EVM2AnyMessage. Pure token transfer, no receiver callback.
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
  if (quote.provider !== "ccip" || !c || (c.sourceFamily ?? "EVM") !== chain.chainType || c.sourceChainId !== chain.chainId ||
      request.srcChainKey !== chain.chainKey || quote.srcAmount !== request.amount ||
      !same(c.sourceToken, request.srcTokenAddress) || !same(c.destinationToken, request.dstTokenAddress) || !same(c.receiver, request.dstWalletAddress) ||
      quote.routeSteps.length !== 1 || quote.routeSteps[0].type !== "CCIP" ||
      quote.routeSteps[0].srcChainKey !== request.srcChainKey || quote.routeSteps[0].dstChainKey !== request.dstChainKey ||
      !isCcipAddress(chain.chainType, c.router) || !isCcipAddress(chain.chainType, c.sourceToken) ||
      !isCcipAddress(c.destinationFamily ?? "EVM", c.receiver) || !isCcipAddress(c.destinationFamily ?? "EVM", c.destinationToken) ||
      uint(c.sourceSelector, 64) === BigInt(0) || uint(c.destinationSelector, 64) === BigInt(0) || c.sourceSelector === c.destinationSelector ||
      uint(quote.srcAmount) === BigInt(0) || uint(quote.dstAmount) === BigInt(0) || uint(c.maxNativeFee) < uint(c.nativeFee) ||
      uint(c.maxNativeFee) > (uint(c.nativeFee) * BigInt(101) + BigInt(99)) / BigInt(100) || !Number.isFinite(c.quotedAt)) {
    throw new Error("CCIP quote does not match the reviewed transfer.");
  }
}

export function ccipMessage(quote: BridgeQuote) {
  if (!quote.ccip) throw new Error("Missing CCIP execution data.");
  return {
    ...ccipMessageEncoding(quote.ccip.sourceFamily ?? "EVM", quote.ccip.destinationFamily ?? "EVM", quote.ccip.receiver),
    data: "0x" as Hex,
    tokenAmounts: [{ token: quote.ccip.sourceToken as Address, amount: BigInt(quote.srcAmount) }],
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
  read: (args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => Promise<bigint>;
  send: (tx: CcipTransaction, kind: "approval" | "bridge") => Promise<string>;
  wait: (hash: string, kind: "approval" | "bridge") => Promise<string>;
  submitted: (hash: string, confirmed: boolean) => void;
  step: (description: string) => void;
};

// No upstream calldata is signed. Build only exact ERC20 approvals and ccipSend locally.
export async function executeCcipTransfer(quote: BridgeQuote, request: CcipQuoteRequest, chain: BridgeChain, sender: string, deps: Dependencies) {
  assertCcipQuote(quote, request, chain);
  if (chain.chainType !== "EVM") throw new Error("Use the source family CCIP executor.");
  if (!isAddress(sender) || same(sender, zeroAddress)) throw new Error("Connect a valid source wallet.");
  const reviewed = quote.ccip!;
  const refresh = async () => {
    deps.assertContext();
    const fresh = await deps.refresh();
    deps.assertContext();
    assertCcipQuote(fresh, request, chain);
    const c = fresh.ccip!;
    if (!same(c.router, reviewed.router) || c.sourceSelector !== reviewed.sourceSelector || c.destinationSelector !== reviewed.destinationSelector ||
        BigInt(fresh.dstAmount) < BigInt(quote.dstAmount) || BigInt(c.nativeFee) > BigInt(reviewed.maxNativeFee) ||
        Date.now() - c.quotedAt > 120_000 || c.quotedAt > Date.now() + 5_000) {
      throw new Error("CCIP quote changed. Refresh and review the new quote before sending.");
    }
    return fresh;
  };
  await refresh();
  const amount = BigInt(request.amount);
  const allowanceArgs = { address: reviewed.sourceToken as Address, abi: erc20Abi, functionName: "allowance", args: [sender, reviewed.router] };
  const allowance = await deps.read(allowanceArgs);
  deps.assertContext();
  if (allowance < amount) {
    // USDT and similar tokens require resetting a nonzero insufficient allowance.
    for (const value of allowance > BigInt(0) ? [BigInt(0), amount] : [amount]) {
      deps.step(value === BigInt(0) ? "Resetting token allowance" : "Approving transfer amount");
      deps.assertContext();
      const hash = await deps.send({ to: reviewed.sourceToken as Address, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reviewed.router as Address, value] }) }, "approval");
      await deps.wait(hash, "approval");
      deps.assertContext();
    }
  }
  deps.step("Checking CCIP fee and transfer amount");
  const fresh = await refresh();
  if (await deps.read(allowanceArgs) < amount) throw new Error("Token approval was not applied. Check the approval transaction.");
  // Final read verifies the exact message's current fee, including after slow approvals.
  const message = ccipMessage(fresh);
  const args = [BigInt(reviewed.destinationSelector), message] as const;
  const fee = await deps.read({ address: reviewed.router as Address, abi: CCIP_ROUTER_ABI, functionName: "getFee", args });
  if (fee < BigInt(0) || fee > BigInt(reviewed.maxNativeFee)) throw new Error("CCIP fee increased. Refresh and review the new quote before sending.");
  deps.assertContext();
  deps.step("Sending CCIP transfer");
  const hash = await deps.send({ to: reviewed.router as Address, data: encodeFunctionData({ abi: CCIP_ROUTER_ABI, functionName: "ccipSend", args }), value: ccipTransactionValue(chain.chainId, fee) }, "bridge");
  deps.submitted(hash, false);
  const confirmedHash = await deps.wait(hash, "bridge");
  deps.submitted(confirmedHash, true);
  return confirmedHash;
}
