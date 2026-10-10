// Server-only TON reads. Layouts are tied to the verified deployed code hashes;
// an upgrade must be reviewed before it can produce another executable quote.
import { Address, Cell, Dictionary, beginCell, contractAddress } from "@ton/core";
import { toHex } from "viem";
import { hexAccount, nonEvmTokenMatches, tonAccount } from "./direct-oft-address";
import type { ReceiveState, ReceiveStateRequest } from "./direct-oft-receive";

const OFT_CODE: Record<string, string> = {
  "5f7427abf346ce5af453baaa0fa8acbdda25c19da48ee916e759e61dfb41743e": "EthenaOFT",
  "4a88695a5862b16bf0345ac88844dde8463117d0cfe406cd72bd32f9a2b6d25f": "OFT",
};
const MINTER_CODE = "a9bfedc76d60b332e8019e405505aadf4d7f870b8d3bae7abcfeb868681e6b2a";
const WALLET_CODE = "fda348fb56e6fca2cf790dde7878d89739b59d073fc115b88ba829ebb5eab68e";
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const COINS_MAX = (BigInt(1) << BigInt(120)) - BigInt(1);
type TonAccountState = { address: string; status: string; code?: string; data?: string; balance?: string; syncTime?: number };
let reads: Promise<unknown> = Promise.resolve();
async function account(address: Address): Promise<TonAccountState> {
  const pending = reads.catch(() => {}).then(async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    const response = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(address.toRawString())}`, {
      signal: AbortSignal.timeout(15000), cache: "no-store",
    });
    if (!response.ok) throw new Error(`TON destination RPC returned HTTP ${response.status}. Please retry.`);
    const data = await response.json();
    const result = data.result;
    // Require an explicit RPC account state. An HTTP 404 or an RPC failure must
    // never be interpreted as a new, unlocked Jetton wallet.
    if (data.ok !== true || result?.["@type"] !== "raw.fullAccountState" ||
      !["active", "uninitialized", "frozen"].includes(result.state) || result.suspended !== false ||
      typeof result.code !== "string" || typeof result.data !== "string" ||
      result.code.length > 350000 || result.data.length > 350000)
      throw new Error("Invalid or suspended TON account response.");
    if (result.state === "uninitialized" && (result.code || result.data || result.frozen_hash))
      throw new Error("Unexpected TON uninitialized account state.");
    return { address: address.toRawString(), status: result.state === "uninitialized" ? "uninit" : result.state,
      balance: result.balance, syncTime: result.sync_utime,
      code: Buffer.from(result.code, "base64").toString("hex"), data: Buffer.from(result.data, "base64").toString("hex") };
  });
  reads = pending;
  return pending;
}
function cell(hex: string | undefined): Cell {
  if (!hex || hex.length > 524288 || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid TON contract cell.");
  const cells = Cell.fromBoc(Buffer.from(hex, "hex"));
  if (cells.length !== 1 || cells[0].isExotic) throw new Error("Unsupported TON contract cell.");
  return cells[0];
}
function activeCode(state: TonAccountState): string {
  if (state.status !== "active") throw new Error("The TON OFT or Jetton contract is not active.");
  return cell(state.code).hash().toString("hex");
}
function assertClass(value: Cell, name: string) {
  if (value.beginParse().loadUintBig(80) !== BigInt(`0x${Buffer.from(name).toString("hex")}`)) throw new Error("Unsupported TON OFT storage class.");
}
// FunC++ classlib: 80-bit name, then fifteen 18-bit descriptors
// (type:4, cell index:2, bit offset:10, ref index:2).
function field(value: Cell, index: number, type: number): { target: Cell; offset: number; ref: number } {
  const header = value.beginParse().skip(80 + index * 18);
  if (header.loadUint(4) !== type) throw new Error("Unsupported TON OFT field type.");
  const cellIndex = header.loadUint(2), offset = header.loadUint(10), ref = header.loadUint(2);
  const target = cellIndex === 0 ? value : value.refs[cellIndex];
  if (!target || target.isExotic) throw new Error("Invalid TON OFT field cell.");
  return { target, offset, ref };
}
function uint(value: Cell, index: number, type: number): bigint {
  const { target, offset } = field(value, index, type);
  return target.beginParse().skip(offset).loadUintBig(2 ** type);
}
function ref(value: Cell, index: number): Cell {
  const { target, ref } = field(value, index, 9);
  if (!target.refs[ref] || target.refs[ref].isExotic) throw new Error("Invalid TON OFT reference.");
  return target.refs[ref];
}
const rawAddress = (hex: string) => Address.parseRaw(`0:${hexAccount(hex).slice(2)}`);

export async function readTonAsset(args: ReceiveStateRequest, direction: "send" | "receive" = "receive") {
  const recipient = rawAddress(tonAccount(args.recipient));
  const oftAddress = rawAddress(args.address);
  const oft = await account(oftAddress);
  const implementation = OFT_CODE[activeCode(oft)];
  if (!implementation) throw new Error("This TON OFT implementation has not yet been verified for direct receiving.");
  const storage = cell(oft.data);
  assertClass(storage, implementation);
  const token = toHex(uint(storage, 1, 8), { size: 32 });
  if (!nonEvmTokenMatches("TON", token, args.token)) throw new Error("Destination TON OFT token does not match the selected asset.");
  const oapp = ref(storage, 0);
  assertClass(oapp, "oAppStore");
  if (uint(oapp, 2, 0) !== BigInt(1) || uint(oapp, 3, 0) !== BigInt(1) || uint(oapp, 5, 5) !== BigInt(30343))
    throw new Error("TON OFT is not initialized for mainnet.");
  const peer = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(256), ref(oapp, 7)).get(BigInt(args.remoteEid));
  if (!peer) throw new Error("Missing TON OFT reverse peer.");
  const gas = ref(storage, 2);
  assertClass(gas, "GasAssert");
  const receiveGas = uint(gas, 1, 5);
  if (receiveGas === BigInt(0) || uint(gas, 3, 5) === BigInt(0) || uint(oapp, 12, 5) === BigInt(0))
    throw new Error("TON OFT receive gas is not configured.");
  // In these verified implementations pause/rate limits govern sends. Receiving
  // refills the outbound bucket; it does not consume an inbound quota.
  const master = rawAddress(token);
  const minter = await account(master);
  if (activeCode(minter) !== MINTER_CODE) throw new Error("Unsupported TON Jetton minter implementation.");
  const minterData = cell(minter.data).beginParse();
  const supply = minterData.loadCoins();
  minterData.loadMaybeAddress(); // admin
  minterData.loadMaybeAddress(); // pending admin
  const authority = minterData.loadAddress();
  const walletCode = minterData.loadRef();
  minterData.loadRef(); // metadata URI; on-chain get_jetton_data fixes decimals at 6
  minterData.endParse();
  if (!authority.equals(oftAddress)) throw new Error("TON OFT is not authorized to mint the selected Jetton.");
  if (walletCode.hash().toString("hex") !== WALLET_CODE) throw new Error("Unsupported TON Jetton wallet implementation.");
  const initialWalletData = beginCell().storeUint(0, 4).storeCoins(0).storeAddress(recipient).storeAddress(master).endCell();
  const walletAddress = contractAddress(0, { code: walletCode, data: initialWalletData });
  const wallet = await account(walletAddress);
  let balance = BigInt(0);
  if (wallet.status === "frozen") throw new Error("The destination TON Jetton wallet is frozen.");
  if (wallet.status === "active") {
    if (activeCode(wallet) !== WALLET_CODE) throw new Error("The destination TON Jetton wallet code has changed.");
    const data = cell(wallet.data).beginParse();
    const status = data.loadUint(4);
    balance = data.loadCoins();
    if (!data.loadAddress().equals(recipient) || !data.loadAddress().equals(master)) throw new Error("TON Jetton wallet owner or token mismatch.");
    data.endParse();
    if (status & (direction === "send" ? 1 : 2)) throw new Error(`The TON Jetton wallet blocks ${direction === "send" ? "outgoing" : "incoming"} transfers.`);
  }
  const max = direction === "send" ? U64_MAX : [U64_MAX, COINS_MAX - supply, COINS_MAX - balance].reduce((a, b) => a < b ? a : b);
  if (max <= BigInt(0)) throw new Error("The TON Jetton has no remaining receive capacity.");
  return { state: { addressBytes32: args.address, tokenAddress: token, decimals: 6, sharedDecimals: 6,
    peer: toHex(peer, { size: 32 }), maxAmountLD: max.toString() }, storage, gas, oapp, oft, master, walletAddress, wallet, balance };
}

export async function readTonReceiveState(args: ReceiveStateRequest): Promise<ReceiveState> {
  return (await readTonAsset(args)).state;
}
export { uint as tonUint, ref as tonRef, assertClass as assertTonClass, account as readTonAccount };
