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

type BridgeQuoteResponseLike = { quotes: unknown[] };

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
import { nonEvmRecipient, nonEvmTokenMatches } from "./direct-oft-address";
import { quoteLegacyNativeOft, isNativeErc20Precompile } from "./direct-oft-native";
import { createTonSourceAdapter, type TonSendRequest, type TonSendQuote } from "./direct-oft-ton-source";
import { verifyOrderlyEvm, orderlyAmount } from "./direct-oft-orderly";
import { createNonEvmReceiveAdapter, fetchNonEvmReceiveState, DIRECT_OFT_RECEIVE_TYPES, type ReceiveStateRequest, type ReceiveState } from "./direct-oft-receive";

export function supportsDirectOftRoute(source: string, destination: string) {
  return source === "EVM"
    ? ["EVM", "SOLANA", ...DIRECT_OFT_RECEIVE_TYPES].includes(destination)
    : ["SOLANA", "TON"].includes(source) && destination === "EVM";
}

export function isNativeOftToken(address: string) {
  return /^(0x0{40}|0xe{40})$/i.test(address);
}

export function directOftAddressMatches(
  chainType: string,
  left: string,
  right: string,
  chainId?: number,
) {
  return chainType === "EVM"
    ? ((isNativeOftToken(left) || isNativeErc20Precompile(chainId, left)) &&
       (isNativeOftToken(right) || isNativeErc20Precompile(chainId, right))) || left.toLowerCase() === right.toLowerCase()
    : nonEvmTokenMatches(chainType, left, right);
}

export function directOftRecipient(chainType: string, address: string): Hex {
  if (chainType === "EVM" && isAddress(address) && !/^0x0{40}$/i.test(address))
    return padHex(address as Address, { size: 32 });
  if (chainType === "SOLANA" && address !== "11111111111111111111111111111111") return toHex(new PublicKey(address).toBytes());
  if (chainType === "EVM" || chainType === "SOLANA") throw new Error(`Invalid ${chainType} direct OFT recipient.`);
  return nonEvmRecipient(chainType, address);
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
  readNativeBalance?: (chain: BridgeChain, address: Address) => Promise<bigint>;
  readEvmCode?: (chain: BridgeChain, address: Address) => Promise<Hex | undefined>;
  readEvmStorage?: (chain: BridgeChain, address: Address, slot: Hex) => Promise<Hex | undefined>;
  loadReceiveState?: (request: ReceiveStateRequest) => Promise<ReceiveState>;
  loadTonSendQuote?: (request: TonSendRequest) => Promise<TonSendQuote>;
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
      if (decoded.functionName === "send" && decoded.args[0].dstEid === dstEid &&
        decoded.args[0].composeMsg === "0x" && decoded.args[0].oftCmd === "0x")
        candidates.add(target);
    } catch { /* Not a standard OFT send. */ }
  };
  const quotes = (data as { quotes?: BridgeQuote[] } | null)?.quotes;
  if (!Array.isArray(quotes)) return [];
  for (const quote of quotes.slice(0, 8)) {
    if (!quote || !Array.isArray(quote.userSteps)) continue;
    // More than one route step can represent a swap, compose, or intermediate bridge.
    if (Array.isArray(quote.routeSteps) && (quote.routeSteps.length > 1 || quote.routeSteps.some(step => /MULTIHOP|COMPOSE|SWAP|HYPERCORE/i.test(step.type)))) continue;
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

async function discoverPeerMetadata(args: DirectOftQuoteArgs, hints: Address[] = [], allowReverse = true): Promise<LayerZeroOftListResponse> {
  if (args.srcChain.chainType === "TON" && args.dstChain.chainType === "EVM") {
    // Discover through the EVM peer, then validate the TON source independently.
    return discoverPeerMetadata({ ...args, srcChain: args.dstChain, dstChain: args.srcChain,
      srcToken: args.dstToken, dstToken: args.srcToken, from: args.to, to: args.from }, [], false);
  }
  if (args.srcChain.chainType === "SOLANA" && args.dstChain.chainType === "EVM") {
    // Standard OFTs can be discovered from the EVM token. Console tokens often
    // use a separate EVM adapter, so also follow Solana mint-authority stores.
    if (allowReverse) {
      const reverse = await discoverPeerMetadata({ ...args, srcChain: args.dstChain, dstChain: args.srcChain,
        srcToken: args.dstToken, dstToken: args.srcToken, from: args.to, to: args.from }, [], false);
      if (reverse.discovered?.length) return reverse;
    }
    const { discoverSolanaOftStores } = await import("./direct-oft-solana-discovery");
    const { createSolanaOftAdapter } = await import("./direct-oft-solana");
    const { DEFAULT_RPC_URLS } = await import("./rpc-config");
    const stores = await discoverSolanaOftStores(args.solanaRpcUrl ?? DEFAULT_RPC_URLS.solana[0], args.srcToken.address, args.metadata);
    const results = await Promise.allSettled(stores.map(async (storeAddress) => {
      const solana = await createSolanaOftAdapter({ rpcUrl: args.solanaRpcUrl, storeAddress,
        deployment: { address: args.srcToken.address }, token: args.srcToken,
        remoteEid: getLayerZeroV2EndpointId(args.dstChain.chainKey)!, simulate: false });
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(solana.peer)) throw new Error("Invalid Solana OFT EVM peer.");
      const address = `0x${solana.peer.slice(-40)}` as Address;
      const [token, peer] = await Promise.all([
        args.read<Address>({ chain: args.dstChain, address, abi: layerZeroOftV2Abi, functionName: "token" }),
        args.read<Hex>({ chain: args.dstChain, address, abi: validationAbi, functionName: "peers", args: [getLayerZeroV2EndpointId("solana")!] }),
      ]);
      if (!directOftAddressMatches("EVM", token, args.dstToken.address, args.dstChain.chainId) || peer.toLowerCase() !== solana.addressBytes32.toLowerCase())
        throw new Error("Unverified Solana OFT reverse peer or destination token.");
      return { endpointVersion: "v2", deployments: {
        [args.srcChain.chainKey]: { address: args.srcToken.address },
        [args.dstChain.chainKey]: { address, innerTokenAddress: args.dstToken.address },
      } };
    }));
    const discovered = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!discovered.length && results.length) throw new Error(`No verified Solana OFT route. ${results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []).join("; ")}`);
    return { discovered };
  }
  if (args.srcChain.chainType !== "EVM" || !supportsDirectOftRoute("EVM", args.dstChain.chainType)) return {};
  const seeds = [
    ...new Set([args.srcToken.address, ...hints].filter((a) => isAddress(a)).map((a) => a.toLowerCase() as Address)),
  ].map((address) => ({ address, local: args.srcChain, remote: args.dstChain, token: args.srcToken, remoteToken: args.dstToken }));
  if (!hints.length && args.dstChain.chainType === "EVM" && isAddress(args.dstToken.address)) seeds.push({
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
    if (!directOftAddressMatches("EVM", actualToken, token.address, local.chainId) || !/^0x[0-9a-f]{64}$/i.test(peer) || /^0x0{64}$/i.test(peer))
      throw new Error("Invalid OFT discovery hint.");
    if (remote.chainType === "SOLANA") {
      const { createSolanaOftAdapter } = await import("./direct-oft-solana");
      const solana = await createSolanaOftAdapter({
        rpcUrl: args.solanaRpcUrl,
        storeAddress: new PublicKey(hexToBytes(peer)).toBase58(),
        deployment: { address: remoteToken.address },
        token: remoteToken,
        remoteEid: localEid,
        simulate: false,
      }).catch((error: unknown) => {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: "SOLANA_OFT_VALIDATION" });
      });
      if (solana.peer.toLowerCase() !== padHex(address, { size: 32 }).toLowerCase())
        throw new Error("Unverified Solana OFT reverse peer.");
      return { endpointVersion: "v2", deployments: {
        [local.chainKey]: { address, innerTokenAddress: token.address },
        [remote.chainKey]: { address: remoteToken.address },
      } };
    }
    if ((DIRECT_OFT_RECEIVE_TYPES as readonly string[]).includes(remote.chainType)) {
      const destination = await createNonEvmReceiveAdapter({
        chainType: remote.chainType, address: peer, token: remoteToken.address, selectedToken: remoteToken,
        remoteEid: localEid, recipient: args.to, loadState: args.loadReceiveState,
      }).catch((error: unknown) => {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: "OFT_RECEIVE_VALIDATION" });
      });
      if (destination.peer.toLowerCase() !== padHex(address, { size: 32 }).toLowerCase())
        throw new Error("Unverified destination OFT reverse peer.");
      return { endpointVersion: "v2", deployments: {
        [local.chainKey]: { address, innerTokenAddress: token.address },
        [remote.chainKey]: { address: peer, innerTokenAddress: remoteToken.address },
      } };
    }
    if (!/^0x0{24}[0-9a-f]{40}$/i.test(peer)) throw new Error("Invalid EVM OFT peer.");
    const peerAddress = `0x${peer.slice(-40)}` as Address;
    if (/^0x0{40}$/i.test(peerAddress)) throw new Error("Missing OFT peer.");
    const [actualRemoteToken, reversePeer] = await Promise.all([
      args.read<Address>({ chain: remote, address: peerAddress, abi: layerZeroOftV2Abi, functionName: "token" }),
      args.read<Hex>({ chain: remote, address: peerAddress, abi: validationAbi, functionName: "peers", args: [localEid] }),
    ]);
    if (!directOftAddressMatches("EVM", actualRemoteToken, remoteToken.address, remote.chainId) ||
      reversePeer.toLowerCase() !== padHex(address, { size: 32 }).toLowerCase())
      throw new Error("Unverified OFT discovery hint.");
    return { endpointVersion: "v2", deployments: {
      [local.chainKey]: { address, innerTokenAddress: token.address },
      [remote.chainKey]: { address: peerAddress, innerTokenAddress: remoteToken.address },
    } };
  }));
  const discovered = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!discovered.length && args.dstChain.chainType === "SOLANA" && allowReverse) {
    const reverse = await discoverPeerMetadata({ ...args, srcChain: args.dstChain, dstChain: args.srcChain,
      srcToken: args.dstToken, dstToken: args.srcToken, from: args.to, to: args.from }, [], false);
    if (reverse.discovered?.length) return reverse;
  }
  if (!discovered.length) {
    const unsupported = results.find((result) => result.status === "rejected" && ["SOLANA_OFT_VALIDATION", "OFT_RECEIVE_VALIDATION"].includes(result.reason?.code));
    if (unsupported?.status === "rejected") throw unsupported.reason;
  }
  return { discovered };
}

export async function buildDirectOftQuote(
  args: DirectOftQuoteArgs,
): Promise<BridgeQuote> {
  // Discovery and construction validate the same destination. Reuse reads only
  // inside this quote, including recursive mesh selection; execution starts fresh.
  const receiveReads = new Map<string, Promise<ReceiveState>>();
  const readReceiveState = args.loadReceiveState ?? fetchNonEvmReceiveState;
  args = { ...args, loadReceiveState: (request) => {
    const key = JSON.stringify(request);
    let pending = receiveReads.get(key);
    if (!pending) { pending = readReceiveState(request); receiveReads.set(key, pending); }
    return pending;
  } };
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
    !supportsDirectOftRoute(srcChain.chainType, dstChain.chainType) ||
    !srcEid ||
    !dstEid ||
    srcEid === dstEid
  ) {
    throw new Error(
      "Direct OFT supports EVM ↔ EVM, Solana ↔ EVM, TON ↔ EVM, and EVM → Aptos / Starknet / Tron / Sui / Stellar. This source/destination family is not yet supported.",
    );
  }
  if (amount <= BigInt(0)) throw new Error("Invalid transfer amount.");
  directOftRecipient(srcChain.chainType, from);
  const recipient = directOftRecipient(dstChain.chainType, to);
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
          srcChain.chainId,
        ) &&
        directOftAddressMatches(
          dstChain.chainType,
          dst.innerTokenAddress || dst.address,
          dstToken.address,
          dstChain.chainId,
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
    if (!discovered.discovered?.length && args.fetchDiscoveryQuote && srcChain.chainType === "EVM" && supportsDirectOftRoute("EVM", dstChain.chainType)) {
      const discoveryResponse = await args.fetchDiscoveryQuote();
      const hints = extractOftCandidates(discoveryResponse, srcChain, dstEid);
      if (!hints.length && Array.isArray((discoveryResponse as BridgeQuoteResponseLike)?.quotes) && !(discoveryResponse as BridgeQuoteResponseLike).quotes.length) {
        throw new Error(`No direct OFT mesh verified for ${srcToken.symbol} from ${srcChain.shortName ?? srcChain.chainKey} to ${dstChain.shortName ?? dstChain.chainKey}; the bridge provider also returned no route. Choose another destination or bridge through a supported intermediate chain.`);
      }
      if (hints.length) discovered = await discoverPeerMetadata(args, hints);
    }
    if (discovered.discovered?.length)
      return buildDirectOftQuote({ ...args, metadata: discovered, discoverPeers: false });
  }
  if (!matches.length)
    throw new Error(
      "No direct OFT mesh found for these token addresses. You can enable Get quotes from third parties or import a custom OFT.",
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
    if (!directOftAddressMatches("EVM", tokenAddress, token.address, chain.chainId))
      throw new Error("On-chain OFT tokens do not match the selected assets.");
    const native = /^0x0{40}$/i.test(tokenAddress);
    const nativeErc20 = isNativeErc20Precompile(chain.chainId, tokenAddress);
    if ((native && approvalRequired) || (isNativeOftToken(token.address) && !native && !nativeErc20))
      throw new Error("This native asset is not a compatible NativeOFTAdapter.");
    const decimals = native ? chain.nativeCurrency.decimals : await read<number>({
      chain, address: tokenAddress, abi: erc20Abi, functionName: "decimals",
    });
    if (nativeErc20 && (decimals !== chain.nativeCurrency.decimals || !approvalRequired))
      throw new Error("Unsupported native ERC-20 OFT configuration.");
    const orderly = await verifyOrderlyEvm({ chainId: chain.chainId, address,
      readCode: args.readEvmCode ? address => args.readEvmCode!(chain, address) : undefined,
      readStorage: args.readEvmStorage ? (address, slot) => args.readEvmStorage!(chain, address, slot) : undefined });
    if (orderly) {
      if (decimals !== 18 || sharedDecimals !== 18 || await call<bigint>(parseAbi(["function decimalConversionRate() view returns(uint256)"]), "decimalConversionRate") !== BigInt(1))
        throw new Error("ORDER decimal configuration changed.");
      if (chain.chainKey === srcChain.chainKey && await call<boolean>(parseAbi(["function onlyTrustCaller() view returns(bool)"]), "onlyTrustCaller") &&
          !await call<boolean>(parseAbi(["function trustAddress(address) view returns(bool)"]), "trustAddress", [from]))
        throw new Error("The ORDER contract restricts sends to approved callers.");
    }
    return {
      addressBytes32: padHex(address as Address, { size: 32 }),
      tokenAddress,
      decimals,
      sharedDecimals,
      ...(orderly ? { amountEncoding: "orderly-u256" as const } : {}),
      ...(!native && approvalRequired && (orderly || nativeErc20) ? { validateReceive: async (_recipient: string, receiveAmount: bigint) => {
        const liquidity = await read<bigint>({ chain, address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [address] });
        if (receiveAmount > liquidity) throw new Error("Destination OFT escrow has insufficient liquidity.");
      } } : {}),
      peer,
      enforcedOptions,
      ...(native ? { validateReceive: async (_recipient: string, receiveAmount: bigint) => {
        if (!args.readNativeBalance) throw new Error("Native OFT destination liquidity cannot be verified.");
        if (receiveAmount > await args.readNativeBalance(chain, address)) throw new Error("Native OFT destination has insufficient liquidity.");
      } } : {}),
      quoteOft: async (params) => {
        if (native) {
          const legacy = await quoteLegacyNativeOft({ chainId: chain.chainId, address, decimals, sharedDecimals, params,
            readCode: args.readEvmCode ? () => args.readEvmCode!(chain, address) : undefined });
          if (legacy) return legacy;
        }
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
        const send = buildCustomOftSendTransaction(address, params, fee, from);
        if (native) {
          // NativeOFTAdapter requires nativeFee + the dustless asset amount;
          // the messaging fee struct itself must still contain only the fee.
          const conversion = BigInt(10) ** BigInt(decimals - sharedDecimals);
          send.value = (fee.nativeFee + params.amountLD / conversion * conversion).toString();
        }
        add("Send directly via OFT", send);
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
  } else if (srcChain.chainType === "TON") {
    destination = await evmAdapter(dstChain, dstToken, srcEid);
    if (!nonEvmTokenMatches("TON", destination.peer, deployments[srcChain.chainKey].address))
      throw new Error("TON source OFT does not match the EVM peer.");
    source = await createTonSourceAdapter({ address: destination.peer, token: srcToken.address, selectedToken: srcToken,
      remoteEid: dstEid, from, to: recipient, amountLD: amount.toString(), checkBalance: args.simulate,
      loadQuote: args.loadTonSendQuote });
  } else if ((DIRECT_OFT_RECEIVE_TYPES as readonly string[]).includes(dstChain.chainType)) {
    source = await evmAdapter(srcChain, srcToken, dstEid);
    destination = await createNonEvmReceiveAdapter({
      chainType: dstChain.chainType, address: source.peer, token: dstToken.address, selectedToken: dstToken,
      remoteEid: srcEid, recipient: to, loadState: args.loadReceiveState,
    });
    if (dstChain.chainType === "TON"
      ? !nonEvmTokenMatches("TON", destination.addressBytes32, deployments[dstChain.chainKey].address)
      : destination.addressBytes32.toLowerCase() !== nonEvmRecipient(dstChain.chainType, deployments[dstChain.chainKey].address).toLowerCase())
      throw new Error("Destination OFT peer does not match the discovered deployment.");
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
  if (source.amountEncoding !== destination.amountEncoding) throw new Error("OFT message encodings do not match.");
  const orderly = source.amountEncoding === "orderly-u256";
  if (
    source.decimals !== srcToken.decimals ||
    destination.decimals !== dstToken.decimals ||
    (!orderly && source.sharedDecimals !== destination.sharedDecimals) ||
    source.sharedDecimals > source.decimals ||
    destination.sharedDecimals > destination.decimals
  )
    throw new Error(
      "OFT decimal configuration does not match the selected tokens.",
    );
  const sendParam: LayerZeroOftV2SendParam = {
    dstEid,
    to: recipient,
    // ORDER's EVM encoder does not remove Solana's eight decimal dust places.
    // Leave that dust in the sender's wallet instead of locking/burning it.
    amountLD: orderly && destination.decimals === 10 && source.decimals === 18
      ? amount / BigInt(100000000) * BigInt(100000000) : amount,
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
  const dstAmount = orderly ? orderlyAmount(receipt.amountReceivedLD, source.decimals, destination.decimals) :
    (receipt.amountReceivedLD /
      BigInt(10) ** BigInt(source.decimals - source.sharedDecimals)) *
    BigInt(10) ** BigInt(destination.decimals - destination.sharedDecimals);
  if (dstAmount <= BigInt(0))
    throw new Error("Destination amount rounds to zero.");
  const amountSD = receipt.amountReceivedLD / BigInt(10) ** BigInt(source.decimals - source.sharedDecimals);
  if ((!orderly && amountSD > (BigInt(1) << BigInt(64)) - BigInt(1)) ||
      (dstChain.chainType === "SOLANA" && dstAmount > (BigInt(1) << BigInt(64)) - BigInt(1)))
    throw new Error("OFT amount exceeds the shared or destination integer limit.");
  await destination.validateReceive?.(to, dstAmount);
  // Solana sends require a funded source token account and a recent blockhash.
  // Fee previews only need quoteOft/quoteSend; build and simulate the send when
  // execution refreshes the quote, so wallet funding cannot hide a valid route.
  const userSteps = srcChain.chainType === "SOLANA" && !args.simulate
    ? []
    : await source.buildSteps(sendParam, fee);
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
