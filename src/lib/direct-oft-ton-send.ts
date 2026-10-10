// Server-only TON quotation. All network operations are reads against a fixed
// mainnet RPC. The wallet receives a locally built Jetton transfer, never an API
// bridge transaction. OFT/minter/wallet code is pinned by readTonAsset.
import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { buildClass, decodeClass } from "@layerzerolabs/lz-ton-sdk-v2";
import { toHex } from "viem";
import { tonOftSendCell, tonOftTransfer } from "./direct-oft-ton-wire";
import { tonAccount } from "./direct-oft-address";
import { readTonAsset, readTonAccount, tonUint, tonRef, assertTonClass } from "./direct-oft-ton";
import type { TonSendRequest, TonSendQuote } from "./direct-oft-ton-source";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const EMPTY = beginCell().endCell();

let pendingRead: Promise<unknown> = Promise.resolve();
async function rpc(method: "runGetMethod" | "getConfigParam", body: object): Promise<Record<string, unknown>> {
  const pending = pendingRead.catch(() => {}).then(async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    const response = await fetch(`https://toncenter.com/api/v2/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), cache: "no-store",
    });
    if (!response.ok) throw new Error(`TON quote RPC returned HTTP ${response.status}. Please retry.`);
    const data = await response.json();
    if (data.ok !== true || !data.result || (method === "runGetMethod" && data.result.exit_code !== 0))
      throw new Error(`TON ${method === "runGetMethod" ? "contract getter failed" : "gas configuration unavailable"}.`);
    return data.result;
  });
  pendingRead = pending;
  return pending;
}
type StackItem = [string, unknown];
async function get(address: Address, method: string, cells: Cell[] = []): Promise<StackItem[]> {
  const result = await rpc("runGetMethod", { address: address.toRawString(), method,
    stack: cells.map(cell => ["tvm.Cell", cell.toBoc().toString("base64")]) });
  if (!Array.isArray(result.stack)) throw new Error("Invalid TON getter stack.");
  return result.stack as StackItem[];
}
function stackCell(item: StackItem): Cell {
  if (item?.[0] !== "cell" || !item[1] || typeof item[1] !== "object" || !("bytes" in item[1]) ||
    typeof item[1].bytes !== "string" || item[1].bytes.length > 350000) throw new Error("Invalid TON cell result.");
  return Cell.fromBase64(item[1].bytes);
}
function stackAddress(item: StackItem): Address {
  if (item?.[0] !== "num" || typeof item[1] !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(item[1])) throw new Error("Invalid TON address result.");
  return Address.parseRaw(`0:${BigInt(item[1]).toString(16).padStart(64, "0")}`);
}
const nonzero = (a: Address) => a.workChain === 0 && !a.hash.equals(Buffer.alloc(32));
const same = (a: Address, b: Address) => a.equals(b);

// TON gas_prices_ext / gas_flat_pfx from config 21, matching GETGASFEE.
export function tonComputeFee(config: Cell, gas: bigint): bigint {
  const s = config.beginParse();
  if (s.loadUint(8) !== 0xd1) throw new Error("Unsupported TON gas configuration.");
  const flatLimit = s.loadUintBig(64), flatPrice = s.loadUintBig(64), tag = s.loadUint(8);
  if (tag !== 0xde && tag !== 0xdd) throw new Error("Unsupported TON gas prices.");
  const price = s.loadUintBig(64);
  if (price <= BigInt(0) || gas <= BigInt(0)) throw new Error("Invalid TON gas budget.");
  return flatPrice + (gas > flatLimit ? ((gas - flatLimit) * price + BigInt(65535)) / BigInt(65536) : BigInt(0));
}
export function tonSendCapacity(storage: Cell, syncTime: number | undefined): bigint {
  if (tonUint(storage, 3, 0) !== BigInt(0)) throw new Error("The source TON OFT is paused.");
  if (!Number.isSafeInteger(syncTime) || syncTime! <= 0 || Math.abs(Date.now() / 1000 - syncTime!) > 180)
    throw new Error("TON chain time is stale; retry the quote.");
  return U64_MAX;
}

export async function quoteTonSend(args: TonSendRequest): Promise<TonSendQuote> {
  if (!args || typeof args.address !== "string" || !/^0x[0-9a-f]{64}$/i.test(args.address) ||
      typeof args.token !== "string" || args.token.length > 128 || typeof args.from !== "string" || args.from.length > 128 ||
      typeof args.to !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(args.to) || /^0x0{64}$/i.test(args.to) ||
      typeof args.amountLD !== "string" || !/^[1-9][0-9]{0,19}$/.test(args.amountLD) || BigInt(args.amountLD) > U64_MAX ||
      !Number.isInteger(args.remoteEid) || args.remoteEid <= 30000 || args.remoteEid > 0xffffffff || args.remoteEid === 30343 ||
      (args.checkBalance !== undefined && typeof args.checkBalance !== "boolean")) throw new Error("Invalid TON OFT send request.");
  const owner = Address.parseRaw(`0:${tonAccount(args.from).slice(2)}`);
  const oftAddress = Address.parseRaw(`0:${args.address.slice(2)}`);
  const amount = BigInt(args.amountLD);
  const asset = await readTonAsset({ chainType: "TON", address: args.address, token: args.token, remoteEid: args.remoteEid, recipient: args.from }, "send");
  let capacity = tonSendCapacity(asset.storage, asset.oft.syncTime);
  const rates = tonRef(asset.storage, 5);
  // classlib stores the direct Hashmap, or an empty cell for no limits.
  const bucket = rates.bits.length ? Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell(), rates).get(BigInt(args.remoteEid)) : undefined;
  if (bucket) {
    assertTonClass(bucket, "Bucket");
    const stored = tonUint(bucket, 0, 6), cap = tonUint(bucket, 1, 6), refill = tonUint(bucket, 2, 6), last = tonUint(bucket, 3, 6);
    const now = BigInt(asset.oft.syncTime!);
    if (stored > cap || last > now) throw new Error("Invalid TON OFT rate limiter.");
    const available = stored + (now - last) * refill;
    capacity = available < cap ? available : cap;
  }
  if (amount > capacity) throw new Error("Amount exceeds the TON OFT outbound rate limit.");
  if (args.checkBalance && (asset.wallet.status !== "active" || asset.balance < amount)) throw new Error("Insufficient TON Jetton balance.");
  const makeMd = (fee: bigint) => tonOftSendCell(args.remoteEid, args.to, amount, fee);
  const sendCell = stackCell((await get(oftAddress, "getLzSendMd", [makeMd(BigInt(0))]))[0]);
  const send = decodeClass("md::LzSend", sendCell);
  const path = send.packet.path;
  if (path.srcEid !== BigInt(30343) || path.dstEid !== BigInt(args.remoteEid) || !same(path.srcOApp, oftAddress) ||
    toHex(path.dstOApp.hash).toLowerCase() !== asset.state.peer.toLowerCase()) throw new Error("TON quote path does not match the OFT peers.");
  const wire = send.packet.message.beginParse();
  if (wire.loadUintBig(256) !== BigInt(args.to) || wire.loadUintBig(64) !== amount || wire.remainingBits || wire.remainingRefs)
    throw new Error("TON OFT message does not match the requested transfer.");
  const options = decodeClass("md::OptionsV1", send.enforcedOptions);
  if (options.lzReceiveGas <= BigInt(0) || options.lzReceiveGas >= BigInt(1) << BigInt(128)) throw new Error("TON OFT has no supported enforced receive gas.");
  const pathCell = buildClass("lz::Path", path);
  const channelAddress = stackAddress((await get(oftAddress, "_getChannelAddress", [pathCell]))[0]);
  const channel = decodeClass("Channel", stackCell((await get(channelAddress, "getContractStorage"))[0]));
  const channelPath = buildClass("lz::Path", channel.path);
  if (!channelPath.equals(pathCell)) throw new Error("TON channel path mismatch.");
  let msglib: Address = channel.epConfigOApp.sendMsglib, connection: Address = channel.epConfigOApp.sendMsglibConnection;
  if (channel.epConfigOApp.isNull) {
    const endpoint = stackCell((await get(channel.endpointAddress, "getContractStorage"))[0]);
    const defaults = await get(channel.endpointAddress, "getSendMsglibAndConnectionDefaults", [endpoint, pathCell]);
    [msglib, connection] = defaults.map(stackAddress);
  }
  if (!nonzero(msglib) || !nonzero(connection)) throw new Error("TON OFT send message library is blocked.");
  const connectionState = decodeClass("UlnConnection", stackCell((await get(connection, "getContractStorage"))[0]));
  if (!same(connectionState.ulnAddress, msglib) || !same(connectionState.channelAddress, channelAddress) ||
      !same(connectionState.endpointAddress, channel.endpointAddress) || !buildClass("lz::Path", connectionState.path).equals(pathCell))
    throw new Error("TON message library connection mismatch.");
  const ulnSend = buildClass("md::UlnSend", { lzSend: send, customUlnSendConfig: connectionState.UlnSendConfigOApp,
    connectionInitialStorage: EMPTY, forwardingAddress: channelAddress });
  const quoteStack = await get(msglib, "ulnQuote", [ulnSend]);
  // Toncenter's tuple representation: [0, actionCall(to, opcode, md)].
  const root = quoteStack[0]?.[1] as { elements?: Array<{ number?: { number?: string }; tuple?: { elements?: Array<{ cell?: { bytes?: string } }> } }> };
  const actions = root?.elements;
  const quoteCell = actions?.[1]?.tuple?.elements?.[3]?.cell?.bytes;
  if (quoteStack[0]?.[0] !== "tuple" || actions?.length !== 2 || actions[0]?.number?.number !== "0" || !quoteCell || quoteCell.length > 350000)
    throw new Error("Invalid TON message fee quote.");
  const quote = decodeClass("md::MsglibSendCallback", Cell.fromBase64(quoteCell));
  if (quote.errorCode !== BigInt(0) || quote.nativeFee <= BigInt(0) || quote.zroFee !== BigInt(0)) throw new Error("TON message library cannot quote this send.");
  if (!buildClass("md::LzSend", quote.lzSend).equals(sendCell)) throw new Error("TON fee quote changed the transfer message.");
  const configResult = await rpc("getConfigParam", { config_id: 21 });
  const config = configResult.config as { bytes?: string } | undefined;
  if (!config?.bytes) throw new Error("TON gas configuration is unavailable.");
  const gasConfig = Cell.fromBase64(config.bytes);
  // Quote a 30% refundable message fee margin, plus source execution gas.
  const nativeFee = (quote.nativeFee * BigInt(13) + BigInt(9)) / BigInt(10);
  const forwardGas = (tonComputeFee(gasConfig, tonUint(asset.gas, 0, 5)) * BigInt(12) + BigInt(9)) / BigInt(10);
  const forward = nativeFee + forwardGas;
  // Covers wallet -> minter -> OFT gas and forwarding. Scales with live gas price.
  const walletGas = tonComputeFee(gasConfig, BigInt(200000));
  const value = forward + walletGas;
  if (args.checkBalance) {
    const sender = await readTonAccount(owner);
    if (!sender.balance || BigInt(sender.balance) < value + walletGas) throw new Error("Insufficient TON balance for messaging and source gas.");
  }
  const payload = tonOftTransfer({ master: asset.master.toRawString(), owner: owner.toRawString(), dstEid: args.remoteEid, to: args.to, amount, fee: nativeFee, forward });
  return { ...asset.state, maxAmountLD: capacity.toString(), amountLD: args.amountLD, from: owner.toRawString(), to: args.to,
    nativeFee: nativeFee.toString(), forward: forward.toString(), value: value.toString(), jettonWallet: asset.walletAddress.toRawString(),
    payload: payload.toBoc().toString("base64"), receiveGas: options.lzReceiveGas.toString(), validUntil: Math.floor(Date.now() / 1000) + 180 };
}
