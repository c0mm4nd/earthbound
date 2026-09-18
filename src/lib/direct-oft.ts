import {
  erc20Abi,
  formatUnits,
  isAddress,
  padHex,
  parseAbi,
  type Abi,
  type Address,
  hexToBytes,
  toHex,
  decodeAbiParameters,
  decodeFunctionData,
  parseAbiParameters,
  type Hex,
} from "viem";
import type {
  BridgeChain,
  BridgeQuote,
  BridgeToken,
  LayerZeroOftListResponse,
  TransactionUserStep,
} from "./bridge-types";
import {
  buildCustomOftApprovalTransaction,
  buildCustomOftSendTransaction,
  getLayerZeroV2EndpointId,
  layerZeroOftV2Abi,
  type LayerZeroMessagingFee,
  type LayerZeroOftV2SendParam,
} from "./custom-oft";

const validationAbi = parseAbi([
  "function peers(uint32) view returns (bytes32)",
  "function sharedDecimals() view returns (uint8)",
  "function enforcedOptions(uint32, uint16) view returns (bytes)",
]);

export type DirectOftReader = <T>(args: {
  chain: BridgeChain;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}) => Promise<T>;

// Require the issuer's receive gas configuration; guessing a gas limit can strand a transfer.
export function hasReceiveGas(options: Hex) {
  if (!/^0x0003[0-9a-f]*$/i.test(options)) return false;
  const bytes = options.slice(6);
  let found = false;
  for (let i = 0; i < bytes.length; ) {
    if (i + 6 > bytes.length) return false;
    const worker = parseInt(bytes.slice(i, i + 2), 16);
    const size = parseInt(bytes.slice(i + 2, i + 6), 16);
    const start = i + 6;
    const end = start + size * 2;
    if (!size || end > bytes.length) return false;
    if (
      worker === 1 &&
      (size === 17 || size === 33) &&
      bytes.slice(start, start + 2) === "01" &&
      BigInt(`0x${bytes.slice(start + 2, start + 34)}`) > BigInt(0)
    )
      found = true;
    i = end;
  }
  return found;
}

import { PublicKey } from "@solana/web3.js";
import type { DirectOftAdapter } from "./direct-oft-types";

export function directOftAddressMatches(
  chainType: string,
  left: string,
  right: string,
) {
  return chainType === "EVM"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function directOftRecipient(chainType: string, address: string): Hex {
  if (chainType === "EVM" && isAddress(address) && !/^0x0{40}$/i.test(address))
    return padHex(address as Address, { size: 32 });
  if (chainType === "SOLANA" && address !== "11111111111111111111111111111111") return toHex(new PublicKey(address).toBytes());
  throw new Error("Invalid direct OFT recipient.");
}

export type DirectOftQuoteArgs = {
  metadata: LayerZeroOftListResponse;
  srcChain: BridgeChain;
  dstChain: BridgeChain;
  srcToken: BridgeToken;
  dstToken: BridgeToken;
  amount: bigint;
  from: string;
  to: string;
  read: DirectOftReader;
  solanaRpcUrl?: string;
  // Execute-time Solana construction includes a simulation before wallet signing.
  simulate?: boolean;
  discoverPeers?: boolean;
  // API transactions are discovery hints only; never return them for execution.
  fetchDiscoveryQuote?: () => Promise<unknown>;
};

export function extractOftCandidates(data: unknown, chain: BridgeChain, dstEid: number): Address[] {
  const candidates = new Set<Address>();
  const inspect = (target: unknown, calldata: unknown) => {
    if (typeof target !== "string" || !isAddress(target) || typeof calldata !== "string") return;
    try {
      const decoded = decodeFunctionData({ abi: layerZeroOftV2Abi, data: calldata as Hex });
      if (decoded.functionName === "send" && decoded.args[0].dstEid === dstEid)
        candidates.add(target);
    } catch { /* Not a standard OFT send. */ }
  };
  const quotes = (data as { quotes?: BridgeQuote[] } | null)?.quotes;
  if (!Array.isArray(quotes)) return [];
  for (const quote of quotes.slice(0, 8)) {
    if (!quote || !Array.isArray(quote.userSteps)) continue;
    for (const step of quote.userSteps.slice(0, 16)) {
      if (!step || step.type !== "TRANSACTION" || step.chainKey !== chain.chainKey || step.chainType !== "EVM") continue;
      const tx = (step as TransactionUserStep).transaction?.encoded;
      if (!tx || typeof tx !== "object" || typeof tx.data !== "string" || tx.data.length > 131072) continue;
      if (tx.chainId !== undefined && Number(tx.chainId) !== chain.chainId) continue;
      inspect(tx.to, tx.data);
      // Stargate's batched call envelope: (target, value, calldata)[] + quote ID.
      // Decode only this known selector, never scan arbitrary calldata for addresses.
      if (tx.data.slice(0, 10).toLowerCase() !== "0x571d3dc7") continue;
      try {
        const [calls] = decodeAbiParameters(
          parseAbiParameters("(address target,uint256 value,bytes callData)[],bytes32"),
          `0x${tx.data.slice(10)}`,
        );
        for (const call of calls.slice(0, 32)) inspect(call.target, call.callData);
      } catch { /* Malformed or unsupported API envelope. */ }
    }
  }
  return [...candidates].slice(0, 8);
}

async function discoverPeerMetadata(args: DirectOftQuoteArgs, hints: Address[] = []): Promise<LayerZeroOftListResponse> {
  if (args.srcChain.chainType !== "EVM" || args.dstChain.chainType !== "EVM") return {};
  const seeds = [
    ...new Set([args.srcToken.address, ...hints].filter((a) => isAddress(a)).map((a) => a.toLowerCase() as Address)),
  ].map((address) => ({ address, local: args.srcChain, remote: args.dstChain, token: args.srcToken, remoteToken: args.dstToken }));
  if (!hints.length && isAddress(args.dstToken.address)) seeds.push({
    address: args.dstToken.address, local: args.dstChain, remote: args.srcChain,
    token: args.dstToken, remoteToken: args.srcToken,
  });
  const results = await Promise.allSettled(seeds.map(async ({ address, local, remote, token, remoteToken }) => {
    const localEid = getLayerZeroV2EndpointId(local.chainKey)!;
    const remoteEid = getLayerZeroV2EndpointId(remote.chainKey)!;
    const [actualToken, peer] = await Promise.all([
      args.read<Address>({ chain: local, address, abi: layerZeroOftV2Abi, functionName: "token" }),
      args.read<Hex>({ chain: local, address, abi: validationAbi, functionName: "peers", args: [remoteEid] }),
    ]);
    if (!directOftAddressMatches("EVM", actualToken, token.address) || !/^0x0{24}[0-9a-f]{40}$/i.test(peer))
      throw new Error("Invalid OFT discovery hint.");
    const peerAddress = `0x${peer.slice(-40)}` as Address;
    if (/^0x0{40}$/i.test(peerAddress)) throw new Error("Missing OFT peer.");
    const [actualRemoteToken, reversePeer] = await Promise.all([
      args.read<Address>({ chain: remote, address: peerAddress, abi: layerZeroOftV2Abi, functionName: "token" }),
      args.read<Hex>({ chain: remote, address: peerAddress, abi: validationAbi, functionName: "peers", args: [localEid] }),
    ]);
    if (!directOftAddressMatches("EVM", actualRemoteToken, remoteToken.address) ||
      reversePeer.toLowerCase() !== padHex(address, { size: 32 }).toLowerCase())
      throw new Error("Unverified OFT discovery hint.");
    return { endpointVersion: "v2", deployments: {
      [local.chainKey]: { address, innerTokenAddress: token.address },
      [remote.chainKey]: { address: peerAddress, innerTokenAddress: remoteToken.address },
    } };
  }));
  return { discovered: results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []) };
}

export async function buildDirectOftQuote(
  args: DirectOftQuoteArgs,
): Promise<BridgeQuote> {
  const {
    metadata,
    srcChain,
    dstChain,
    srcToken,
    dstToken,
    amount,
    from,
    to,
    read,
  } = args;
  const srcEid = getLayerZeroV2EndpointId(srcChain.chainKey);
  const dstEid = getLayerZeroV2EndpointId(dstChain.chainKey);
  if (
    ![srcChain, dstChain].every((chain) =>
      ["EVM", "SOLANA"].includes(chain.chainType),
    ) ||
    !srcEid ||
    !dstEid ||
    srcEid === dstEid
  ) {
    throw new Error(
      "Direct OFT supports EVM ↔ EVM and Solana ↔ EVM Endpoint V2 routes. Other API routes are available separately.",
    );
  }
  if (amount <= BigInt(0)) throw new Error("Invalid transfer amount.");
  directOftRecipient(srcChain.chainType, from);
  const recipient = directOftRecipient(dstChain.chainType, to);
  const isNative = (address: string) => /^(0x0{40}|0xe{40})$/i.test(address);
  if (isNative(srcToken.address) || isNative(dstToken.address))
    throw new Error(
      "Direct OFT requires token assets; native-asset API routes are available separately.",
    );
  const matchingEntries = Object.values(metadata)
    .flat()
    .filter((entry) => {
      if (entry.endpointVersion?.toLowerCase() !== "v2") return false;
      const src = entry.deployments?.[srcChain.chainKey];
      const dst = entry.deployments?.[dstChain.chainKey];
      return (
        src &&
        dst &&
        directOftAddressMatches(
          srcChain.chainType,
          src.innerTokenAddress || src.address,
          srcToken.address,
        ) &&
        directOftAddressMatches(
          dstChain.chainType,
          dst.innerTokenAddress || dst.address,
          dstToken.address,
        )
      );
    });
  const matches = [
    ...new Map(
      matchingEntries.map((entry) => [
        [srcChain, dstChain]
          .map((chain) => {
            const address = entry.deployments![chain.chainKey].address;
            return chain.chainType === "EVM" ? address.toLowerCase() : address;
          })
          .join(":"),
        entry,
      ]),
    ).values(),
  ];
  if (!matches.length && args.discoverPeers) {
    let discovered = await discoverPeerMetadata(args);
    if (!discovered.discovered?.length && args.fetchDiscoveryQuote && srcChain.chainType === "EVM" && dstChain.chainType === "EVM") {
      const hints = extractOftCandidates(await args.fetchDiscoveryQuote(), srcChain, dstEid);
      if (hints.length) discovered = await discoverPeerMetadata(args, hints);
    }
    if (discovered.discovered?.length)
      return buildDirectOftQuote({ ...args, metadata: discovered, discoverPeers: false });
  }
  if (!matches.length)
    throw new Error(
      "No direct OFT mesh found for these token addresses. No Stargate fallback was used. You can explicitly select API routes or import a custom OFT.",
    );
  if (matches.length > 1) {
    const results = await Promise.allSettled(
      matches.map((entry) =>
        buildDirectOftQuote({ ...args, metadata: { mesh: [entry] } }),
      ),
    );
    const quotes = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (!quotes.length)
      throw new Error(
        `No verified direct OFT route. ${results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : [])).join("; ")}`,
      );
    return quotes.sort((left, right) => {
      const difference =
        BigInt(right.dstAmount) - BigInt(left.dstAmount) ||
        BigInt(left.directOft!.nativeFee) - BigInt(right.directOft!.nativeFee);
      return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
    })[0];
  }
  const deployments = matches[0].deployments!;
  const evmAdapter = async (
    chain: BridgeChain,
    token: BridgeToken,
    remoteEid: number,
  ): Promise<DirectOftAdapter> => {
    const address = deployments[chain.chainKey].address;
    if (!isAddress(address)) throw new Error("Invalid OFT deployment address.");
    const call = <T>(
      abi: Abi,
      functionName: string,
      params?: readonly unknown[],
    ) =>
      read<T>({
        chain,
        address: address as Address,
        abi,
        functionName,
        args: params,
      });
    const [
      peer,
      tokenAddress,
      sharedDecimals,
      approvalRequired,
      enforcedOptions,
    ] = await Promise.all([
      call<Hex>(validationAbi, "peers", [remoteEid]),
      call<Address>(layerZeroOftV2Abi, "token"),
      call<number>(validationAbi, "sharedDecimals"),
      call<boolean>(layerZeroOftV2Abi, "approvalRequired"),
      call<Hex>(validationAbi, "enforcedOptions", [remoteEid, 1]),
    ]);
    if (!directOftAddressMatches("EVM", tokenAddress, token.address))
      throw new Error("On-chain OFT tokens do not match the selected assets.");
    const decimals = await read<number>({
      chain,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "decimals",
    });
    return {
      addressBytes32: padHex(address as Address, { size: 32 }),
      tokenAddress,
      decimals,
      sharedDecimals,
      peer,
      enforcedOptions,
      quoteOft: async (params) => {
        const [limits, fees, receipt] = await call<
          readonly [
            { minAmountLD: bigint; maxAmountLD: bigint },
            readonly unknown[],
            { amountSentLD: bigint; amountReceivedLD: bigint },
          ]
        >(layerZeroOftV2Abi, "quoteOFT", [params]);
        // Legacy OFTCore reports uint64.max as an unused limit in LD.
        // Its actual wire limit is uint64.max in shared decimals. Only
        // normalize the default, fee-free receipt; retain custom limits.
        const conversion = BigInt(10) ** BigInt(decimals - sharedDecimals);
        const dustlessAmount = params.amountLD / conversion * conversion;
        const legacyDefaultLimit = limits.minAmountLD === BigInt(0) &&
          limits.maxAmountLD === (BigInt(1) << BigInt(64)) - BigInt(1) &&
          fees.length === 0 && receipt.amountSentLD === dustlessAmount &&
          receipt.amountReceivedLD === dustlessAmount;
        return {
          ...limits,
          maxAmountLD: legacyDefaultLimit ? limits.maxAmountLD * conversion : limits.maxAmountLD,
          ...receipt,
        };
      },
      quoteSend: (params) =>
        call<LayerZeroMessagingFee>(layerZeroOftV2Abi, "quoteSend", [
          params,
          false,
        ]),
      buildSteps: async (params, fee) => {
        const steps: TransactionUserStep[] = [];
        const add = (
          description: string,
          encoded: TransactionUserStep["transaction"]["encoded"],
        ) =>
          steps.push({
            type: "TRANSACTION",
            chainType: "EVM",
            chainKey: chain.chainKey,
            description,
            transaction: { encoded },
          });
        if (approvalRequired) {
          const allowance = await read<bigint>({
            chain,
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "allowance",
            args: [from, address],
          });
          if (allowance < amount) {
            if (allowance > BigInt(0))
              add(
                "Reset OFT allowance",
                buildCustomOftApprovalTransaction(
                  tokenAddress,
                  address,
                  BigInt(0),
                ),
              );
            add(
              "Approve OFT",
              buildCustomOftApprovalTransaction(tokenAddress, address, amount),
            );
          }
        }
        add(
          "Send directly via OFT",
          buildCustomOftSendTransaction(address, params, fee, from),
        );
        return steps;
      },
    };
  };
  let source: DirectOftAdapter;
  let destination: DirectOftAdapter;
  if (srcChain.chainType === "EVM" && dstChain.chainType === "EVM") {
    [source, destination] = await Promise.all([
      evmAdapter(srcChain, srcToken, dstEid),
      evmAdapter(dstChain, dstToken, srcEid),
    ]);
  } else {
    const sourceIsSolana = srcChain.chainType === "SOLANA";
    const evm = await evmAdapter(
      sourceIsSolana ? dstChain : srcChain,
      sourceIsSolana ? dstToken : srcToken,
      sourceIsSolana ? srcEid : dstEid,
    );
    const { createSolanaOftAdapter } = await import("./direct-oft-solana");
    const solana = await createSolanaOftAdapter({
      rpcUrl: args.solanaRpcUrl,
      storeAddress: new PublicKey(hexToBytes(evm.peer)).toBase58(),
      deployment:
        deployments[sourceIsSolana ? srcChain.chainKey : dstChain.chainKey],
      token: sourceIsSolana ? srcToken : dstToken,
      remoteEid: sourceIsSolana ? dstEid : srcEid,
      from: sourceIsSolana ? from : undefined,
      simulate: args.simulate ?? false,
    });
    [source, destination] = sourceIsSolana ? [solana, evm] : [evm, solana];
  }
  if (
    source.peer.toLowerCase() !== destination.addressBytes32.toLowerCase() ||
    destination.peer.toLowerCase() !== source.addressBytes32.toLowerCase()
  )
    throw new Error("OFT peers do not match the selected deployments.");
  if (!hasReceiveGas(source.enforcedOptions))
    throw new Error("This OFT has no supported enforced receive gas option.");
  if (
    source.decimals !== srcToken.decimals ||
    destination.decimals !== dstToken.decimals ||
    source.sharedDecimals !== destination.sharedDecimals ||
    source.sharedDecimals > source.decimals ||
    destination.sharedDecimals > destination.decimals
  )
    throw new Error(
      "OFT decimal configuration does not match the selected tokens.",
    );
  const sendParam: LayerZeroOftV2SendParam = {
    dstEid,
    to: recipient,
    amountLD: amount,
    minAmountLD: BigInt(0),
    extraOptions: destination.receiveOptions
      ? await destination.receiveOptions(to, source.enforcedOptions)
      : "0x",
    composeMsg: "0x",
    oftCmd: "0x",
  };
  const receipt = await source.quoteOft(sendParam);
  if (
    amount < receipt.minAmountLD ||
    amount > receipt.maxAmountLD ||
    receipt.amountReceivedLD <= BigInt(0) ||
    receipt.amountSentLD <= BigInt(0) || receipt.amountSentLD > amount
  )
    throw new Error("Amount is outside the direct OFT transfer limits.");
  sendParam.minAmountLD = receipt.amountReceivedLD;
  const fee = await source.quoteSend(sendParam);
  if (fee.lzTokenFee !== BigInt(0))
    throw new Error("This route requires unsupported LZ token payment.");
  const dstAmount =
    (receipt.amountReceivedLD /
      BigInt(10) ** BigInt(source.decimals - source.sharedDecimals)) *
    BigInt(10) ** BigInt(destination.decimals - destination.sharedDecimals);
  if (dstAmount <= BigInt(0))
    throw new Error("Destination amount rounds to zero.");
  const amountSD = receipt.amountReceivedLD / BigInt(10) ** BigInt(source.decimals - source.sharedDecimals);
  if (amountSD > (BigInt(1) << BigInt(64)) - BigInt(1) ||
      (dstChain.chainType === "SOLANA" && dstAmount > (BigInt(1) << BigInt(64)) - BigInt(1)))
    throw new Error("OFT amount exceeds the shared or destination integer limit.");
  const userSteps = await source.buildSteps(sendParam, fee);
  const tokenFee = receipt.amountSentLD - receipt.amountReceivedLD;
  const nativeUsd = srcChain.nativeCurrency.price?.usd;
  const tokenUsd = srcToken.price?.usd;
  const meshKey = `${srcEid}:${source.addressBytes32}:${dstEid}:${destination.addressBytes32}`;
  return {
    id: `direct-oft:${meshKey}:${Date.now()}`,
    directOft: { meshKey, nativeFee: fee.nativeFee.toString() },
    srcAmount: amount.toString(),
    dstAmount: dstAmount.toString(),
    dstAmountMin: dstAmount.toString(),
    routeSteps: [
      {
        type: "DIRECT_OFT",
        srcChainKey: srcChain.chainKey,
        dstChainKey: dstChain.chainKey,
      },
    ],
    userSteps,
    fees: [
      {
        type: "MESSAGING",
        description: "LayerZero messaging (source gas extra)",
        amount: fee.nativeFee.toString(),
        chainKey: srcChain.chainKey,
        symbol: srcChain.nativeCurrency.symbol,
        decimals: srcChain.nativeCurrency.decimals,
        amountUsd:
          nativeUsd === undefined
            ? undefined
            : String(
                Number(
                  formatUnits(fee.nativeFee, srcChain.nativeCurrency.decimals),
                ) * nativeUsd,
              ),
      },
      ...(tokenFee !== BigInt(0)
        ? [
            {
              type: "OFT",
              description: "OFT contract fee / reward",
              amount: tokenFee.toString(),
              chainKey: srcChain.chainKey,
              symbol: srcToken.symbol,
              decimals: source.decimals,
              amountUsd:
                tokenUsd === undefined
                  ? undefined
                  : String(
                      Number(formatUnits(tokenFee, source.decimals)) * tokenUsd,
                    ),
            },
          ]
        : []),
    ],
  };
}
