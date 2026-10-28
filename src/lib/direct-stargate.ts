import { encodeFunctionData, erc20Abi, formatUnits, isAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import type { BridgeChain, BridgeQuote, BridgeToken, TransactionUserStep } from "./bridge-types";
import { buildCustomOftApprovalTransaction, getLayerZeroV2EndpointId, layerZeroOftV2Abi, type LayerZeroMessagingFee, type LayerZeroOftV2SendParam } from "./custom-oft";
import { hasReceiveGas, type DirectOftQuoteArgs } from "./direct-oft";
import { findStargateRoute, type StargateDeployment } from "./stargate-deployments";

export const stargateAbi = parseAbi([
  "function getAddressConfig() view returns ((address feeLib,address planner,address treasurer,address tokenMessaging,address creditMessaging,address lzToken))",
  "function localEid() view returns (uint32)",
  "function oftVersion() view returns (bytes4,uint64)",
  "function stargateType() view returns (uint8)",
  "function status() view returns (uint8)",
  "function sharedDecimals() view returns (uint8)",
  "function poolBalance() view returns (uint256)",
  "function sendToken((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),(uint256 nativeFee,uint256 lzTokenFee),address) payable returns ((bytes32 guid,uint64 nonce,(uint256 nativeFee,uint256 lzTokenFee) fee),(uint256 amountSentLD,uint256 amountReceivedLD),(uint72 ticketId,bytes passengerBytes))",
]);

export const stargateMessagingAbi = parseAbi([
  "function peers(uint32) view returns (bytes32)",
  "function assetIds(address) view returns (uint16)",
  "function stargateImpls(uint16) view returns (address)",
  "function enforcedOptions(uint32,uint16) view returns (bytes)",
]);

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const uint64Max = (BigInt(1) << BigInt(64)) - BigInt(1);

// Only pinned official deployments are eligible. API calldata is never a trust
// anchor: Hydra does not use the standard OFT wire format or OFT peer mapping.
export async function buildDirectStargateQuote(args: DirectOftQuoteArgs): Promise<BridgeQuote> {
  const { srcChain, dstChain, srcToken, dstToken, amount, from, to, read } = args;
  const route = findStargateRoute(srcChain, dstChain, srcToken, dstToken);
  if (!route) throw new Error("No registered Stargate V2 route for these assets.");
  const srcEid = getLayerZeroV2EndpointId(srcChain.chainKey);
  const dstEid = getLayerZeroV2EndpointId(dstChain.chainKey);
  if (!srcEid || !dstEid || srcEid === dstEid) throw new Error("Invalid Stargate endpoints.");
  if (amount <= BigInt(0)) throw new Error("Invalid transfer amount.");
  if (![from, to].every(address => isAddress(address) && !/^0x0{40}$/i.test(address)))
    throw new Error("Invalid Stargate sender or recipient.");

  const verify = async (chain: BridgeChain, token: BridgeToken, deployment: StargateDeployment, remote: StargateDeployment, eid: number, remoteEid: number) => {
    const call = <T>(functionName: string) => read<T>({ chain, address: deployment.address, abi: stargateAbi, functionName });
    const [config, localEid, version, type, status, sharedDecimals, actualToken, decimals, approvalRequired, peer, assetId] = await Promise.all([
      call<{ tokenMessaging: Address }>("getAddressConfig"),
      call<number>("localEid"),
      call<readonly [Hex, bigint]>("oftVersion"),
      call<number>("stargateType"),
      call<number>("status"),
      call<number>("sharedDecimals"),
      read<Address>({ chain, address: deployment.address, abi: layerZeroOftV2Abi, functionName: "token" }),
      read<number>({ chain, address: deployment.token, abi: erc20Abi, functionName: "decimals" }),
      read<boolean>({ chain, address: deployment.address, abi: layerZeroOftV2Abi, functionName: "approvalRequired" }),
      read<Hex>({ chain, address: deployment.messaging, abi: stargateMessagingAbi, functionName: "peers", args: [remoteEid] }),
      read<number>({ chain, address: deployment.messaging, abi: stargateMessagingAbi, functionName: "assetIds", args: [deployment.address] }),
    ]);
    if (!sameAddress(config.tokenMessaging, deployment.messaging) || localEid !== eid ||
        version[0] !== "0x02e49c2c" || version[1] !== BigInt(0) || type !== deployment.type)
      throw new Error("Stargate deployment configuration changed.");
    if (status !== 1) throw new Error(`Stargate is paused or unavailable on ${chain.shortName ?? chain.chainKey}.`);
    if (!sameAddress(actualToken, token.address) || !sameAddress(actualToken, deployment.token) || !approvalRequired)
      throw new Error("Stargate token or approval configuration does not match the selected asset.");
    if (decimals !== token.decimals || sharedDecimals > decimals || sharedDecimals < 0)
      throw new Error("Stargate decimal configuration does not match the selected token.");
    if (!sameAddress(peer, padHex(remote.messaging, { size: 32 })))
      throw new Error("Stargate TokenMessaging peers do not match the selected deployments.");
    if (!assetId) throw new Error("Stargate asset is not registered in TokenMessaging.");
    const implementation = await read<Address>({ chain, address: deployment.messaging, abi: stargateMessagingAbi, functionName: "stargateImpls", args: [assetId] });
    if (!sameAddress(implementation, deployment.address)) throw new Error("Stargate asset mapping does not match the selected deployment.");
    return { decimals, sharedDecimals, assetId };
  };
  const [source, destination, options] = await Promise.all([
    verify(srcChain, srcToken, route.source, route.destination, srcEid, dstEid),
    verify(dstChain, dstToken, route.destination, route.source, dstEid, srcEid),
    read<Hex>({ chain: srcChain, address: route.source.messaging, abi: stargateMessagingAbi, functionName: "enforcedOptions", args: [dstEid, 1] }),
  ]);
  if (source.assetId !== destination.assetId || source.sharedDecimals !== destination.sharedDecimals)
    throw new Error("Stargate asset IDs or shared decimals do not match across chains.");
  if (!hasReceiveGas(options)) throw new Error("Stargate Taxi has no supported enforced receive gas option.");

  const conversion = BigInt(10) ** BigInt(source.decimals - source.sharedDecimals);
  const amountLD = amount / conversion * conversion;
  if (amountLD === BigInt(0) || amountLD / conversion > uint64Max)
    throw new Error("Amount is outside the Stargate shared-decimal limits.");
  const params: LayerZeroOftV2SendParam = {
    dstEid, to: padHex(to as Address, { size: 32 }), amountLD, minAmountLD: BigInt(0),
    extraOptions: "0x", composeMsg: "0x", oftCmd: "0x", // Taxi; no bus queue or compose.
  };
  const [limits, , receipt] = await read<readonly [
    { minAmountLD: bigint; maxAmountLD: bigint }, unknown[],
    { amountSentLD: bigint; amountReceivedLD: bigint },
  ]>({ chain: srcChain, address: route.source.address, abi: layerZeroOftV2Abi, functionName: "quoteOFT", args: [params], account: from as Address });
  // quoteOFT silently caps to available path credit; never turn a user's request
  // into a partial transfer. Fees/rewards stay in the receipt, not in a wrapper.
  if (amountLD < limits.minAmountLD || amountLD > limits.maxAmountLD || receipt.amountSentLD !== amountLD ||
      receipt.amountReceivedLD <= BigInt(0) || receipt.amountReceivedLD % conversion !== BigInt(0) ||
      receipt.amountReceivedLD / conversion > uint64Max)
    throw new Error("Amount is outside the Stargate transfer limits or available path credit.");
  params.minAmountLD = receipt.amountReceivedLD;
  const dstAmount = receipt.amountReceivedLD / conversion * BigInt(10) ** BigInt(destination.decimals - destination.sharedDecimals);
  const [fee, allowance] = await Promise.all([
    read<LayerZeroMessagingFee>({ chain: srcChain, address: route.source.address, abi: layerZeroOftV2Abi, functionName: "quoteSend", args: [params, false], account: from as Address }),
    read<bigint>({ chain: srcChain, address: route.source.token, abi: erc20Abi, functionName: "allowance", args: [from, route.source.address] }),
    ...(route.destination.type === 0 ? [(async () => {
      const [poolBalance, balance] = await Promise.all([
        read<bigint>({ chain: dstChain, address: route.destination.address, abi: stargateAbi, functionName: "poolBalance" }),
        read<bigint>({ chain: dstChain, address: route.destination.token, abi: erc20Abi, functionName: "balanceOf", args: [route.destination.address] }),
      ]);
      if (dstAmount > poolBalance || dstAmount > balance) throw new Error("Destination Stargate pool has insufficient liquidity.");
    })()] : []),
  ]);
  if (fee.lzTokenFee !== BigInt(0)) throw new Error("Stargate route requires unsupported LZ token payment.");
  const userSteps: TransactionUserStep[] = [];
  const add = (description: string, encoded: TransactionUserStep["transaction"]["encoded"]) => userSteps.push({
    type: "TRANSACTION", chainType: "EVM", chainKey: srcChain.chainKey, description,
    transaction: { encoded: { ...encoded, chainId: srcChain.chainId, from } },
  });
  if (allowance < amountLD) {
    if (allowance > BigInt(0)) add("Reset Stargate allowance", buildCustomOftApprovalTransaction(route.source.token, route.source.address, BigInt(0)));
    add("Approve Stargate", buildCustomOftApprovalTransaction(route.source.token, route.source.address, amountLD));
  }
  add("Send directly via Stargate", {
    to: route.source.address,
    data: encodeFunctionData({ abi: stargateAbi, functionName: "sendToken", args: [params, fee, from as Address] }),
    value: fee.nativeFee.toString(),
  });
  const tokenFee = amountLD - receipt.amountReceivedLD;
  const usd = (value: bigint, decimals: number, price?: number) => price === undefined ? undefined : String(Number(formatUnits(value, decimals)) * price);
  // Includes messaging contracts and asset ID so execution rejects a changed
  // path even if the Stargate token addresses themselves have not changed.
  const meshKey = `stargate-v2:${srcEid}:${route.source.address}:${route.source.messaging}:${dstEid}:${route.destination.address}:${route.destination.messaging}:${source.assetId}`;
  return {
    id: `${meshKey}:${Date.now()}`,
    directOft: { meshKey, nativeFee: fee.nativeFee.toString() },
    srcAmount: amountLD.toString(), dstAmount: dstAmount.toString(), dstAmountMin: dstAmount.toString(),
    routeSteps: [{ type: "DIRECT_STARGATE_V2", srcChainKey: srcChain.chainKey, dstChainKey: dstChain.chainKey }],
    userSteps,
    fees: [
      { type: "MESSAGING", description: "LayerZero messaging (source gas extra)", amount: fee.nativeFee.toString(),
        chainKey: srcChain.chainKey, symbol: srcChain.nativeCurrency.symbol, decimals: srcChain.nativeCurrency.decimals,
        amountUsd: usd(fee.nativeFee, srcChain.nativeCurrency.decimals, srcChain.nativeCurrency.price?.usd) },
      ...(tokenFee !== BigInt(0) ? [{ type: "PROTOCOL", description: tokenFee > BigInt(0) ? "Stargate protocol fee" : "Stargate protocol reward",
        amount: tokenFee.toString(), chainKey: srcChain.chainKey, symbol: srcToken.symbol, decimals: source.decimals,
        amountUsd: usd(tokenFee, source.decimals, srcToken.price?.usd) }] : []),
    ],
  };
}
