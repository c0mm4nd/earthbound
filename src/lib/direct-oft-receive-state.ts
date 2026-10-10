// Server-side, read-only destination validation. RPC hosts and operations are fixed;
// callers cannot turn this endpoint into a general proxy or submit transactions.
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { hexAccount, nonEvmRecipient, nonEvmTokenMatches } from "./direct-oft-address";
import type { ReceiveState, ReceiveStateRequest } from "./direct-oft-receive";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
// Move resource contents have deployment-specific fields, checked before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function json(url: string, body?: unknown): Promise<Json> {
  const response = await fetch(url, {
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Destination RPC returned HTTP ${response.status}. Please retry.`);
  const data = await response.json();
  if (data.error || data.errors) throw new Error(`Destination RPC: ${JSON.stringify(data.error ?? data.errors).slice(0, 300)}`);
  return data;
}
function integer(value: unknown, label: string): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isInteger(n) || n < 0 || n > 255) throw new Error(`Invalid ${label}.`);
  return n;
}
function u256(words: string[]): bigint {
  if (words.length !== 2 || words.some(w => !/^0x[0-9a-f]+$/i.test(w) || BigInt(w) >= (BigInt(1) << BigInt(128))))
    throw new Error("Invalid Cairo u256 response.");
  return BigInt(words[0]) + (BigInt(words[1]) << BigInt(128));
}
function state(args: ReceiveStateRequest, token: string, decimals: unknown, shared: unknown, peer: string, max = U256_MAX): ReceiveState {
  if (!nonEvmTokenMatches(args.chainType, token, args.token)) throw new Error("Destination OFT token does not match the selected asset.");
  const ld = integer(decimals, "token decimals"), sd = integer(shared, "shared decimals");
  if (sd > ld || max < BigInt(0)) throw new Error("Invalid destination OFT decimal configuration or capacity.");
  return { addressBytes32: args.address, tokenAddress: token, decimals: ld, sharedDecimals: sd, peer: hexAccount(peer), maxAmountLD: max.toString() };
}

async function aptos(args: ReceiveStateRequest): Promise<ReceiveState> {
  const base = "https://fullnode.mainnet.aptoslabs.com/v1";
  const view = (module: string, name: string, params: unknown[] = []) => json(`${base}/view`, {
    function: `${args.address}::${module}::${name}`, type_arguments: [], arguments: params,
  });
  const [resources, [token], [shared], [peer]] = await Promise.all([
    json(`${base}/accounts/${args.address}/resources`), view("oft", "token"), view("oft", "shared_decimals"), view("oft", "get_peer", [args.remoteEid]),
  ]);
  if (!Array.isArray(resources)) throw new Error("Invalid Aptos OFT resources.");
  const resource = (suffix: string) => resources.find(r => r.type.endsWith(suffix) && hexAccount(r.type.split("::")[0]) === args.address)?.data;
  const minted = resource("::oft_fa::OftImpl");
  const escrowed = resource("::oft_adapter_fa::OftImpl");
  const implModule = minted ? "oft_fa" : "oft_adapter_fa";
  const implToken = minted?.metadata?.inner ?? escrowed?.metadata?.vec?.[0]?.inner;
  if (!implToken || !nonEvmTokenMatches("APTOS", implToken, token))
    throw new Error("This Aptos OFT implementation is not yet supported for direct receiving.");
  // Some catalog assets still use a Coin type. Prove its on-chain FA pairing.
  if (args.token.includes("::")) {
    if (!/^0x[0-9a-f]{1,64}::[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.token)) throw new Error("Unsupported Aptos coin type.");
    const [pair] = await json(`${base}/view`, { function: "0x1::coin::paired_metadata", type_arguments: [args.token], arguments: [] });
    if (!pair?.vec?.[0]?.inner || hexAccount(pair.vec[0].inner) !== hexAccount(token)) throw new Error("Aptos coin is not paired with the OFT asset.");
  } else if (!nonEvmTokenMatches("APTOS", token, args.token)) throw new Error("Destination OFT token does not match the selected asset.");
  const store = resource("::oft_store::OftStore");
  const config = resource("::oft_impl_config::Config");
  if (!config || typeof config.blocklist_enabled !== "boolean") throw new Error("Unsupported Aptos OFT receive policy.");
  if (config.blocklist_enabled) {
    const [blocked] = await view(implModule, "is_blocklisted", [args.recipient]);
    if (blocked !== false) throw new Error("The Aptos OFT blocks this recipient; its receive would be redirected.");
  }
  let capacity = U64_MAX;
  if (escrowed) {
    const [tvl] = await view(implModule, "tvl");
    capacity = BigInt(tvl);
    const [escrow] = await view(implModule, "escrow_address");
    const [frozen] = await json(`${base}/view`, { function: "0x1::primary_fungible_store::is_frozen", type_arguments: ["0x1::fungible_asset::Metadata"], arguments: [escrow, token] });
    if (frozen !== false) throw new Error("The Aptos OFT escrow is frozen.");
  }
  const metadata = await json(`${base}/accounts/${hexAccount(token)}/resource/0x1::fungible_asset::Metadata`);
  const result = state(args, args.token, metadata.data?.decimals, shared, peer, capacity);
  if (!store || BigInt(store.decimal_conversion_rate) !== BigInt(10) ** BigInt(result.decimals - result.sharedDecimals))
    throw new Error("Invalid Aptos OFT decimal conversion rate.");
  return result;
}

async function starknet(args: ReceiveStateRequest): Promise<ReceiveState> {
  hexAccount(args.address, 251);
  const call = async (address: string, name: string, calldata: string[] = []): Promise<string[]> => {
    const selector = BigInt(keccak256(stringToHex(name))) & ((BigInt(1) << BigInt(250)) - BigInt(1));
    const data = await json("https://starknet-rpc.publicnode.com", {
      jsonrpc: "2.0", id: 1, method: "starknet_call", params: { block_id: "latest", request: {
        contract_address: address, entry_point_selector: toHex(selector), calldata,
      } },
    });
    if (!Array.isArray(data.result)) throw new Error("Invalid Starknet RPC response.");
    return data.result;
  };
  const [[token], [shared], peer, [paused], enabled] = await Promise.all([
    call(args.address, "token"), call(args.address, "shared_decimals"), call(args.address, "get_peer", [toHex(args.remoteEid)]),
    call(args.address, "is_paused"), call(args.address, "get_rate_limit_enabled"),
  ]);
  if (BigInt(paused) !== BigInt(0)) throw new Error("The destination Starknet OFT is paused.");
  if (enabled.length !== 2 || !["0x0", "0x1"].includes(enabled[1])) throw new Error("Unsupported Starknet OFT rate limiter.");
  let capacity = U256_MAX;
  if (BigInt(enabled[1]) !== BigInt(0)) {
    const amounts = await call(args.address, "get_receivable_amount", [toHex(args.remoteEid)]);
    if (amounts.length !== 4) throw new Error("Invalid Starknet receive capacity.");
    capacity = u256(amounts.slice(2));
  }
  const [decimals] = await call(token, "decimals");
  return state(args, token, decimals, shared, toHex(u256(peer), { size: 32 }), capacity);
}

let tronQueue: Promise<unknown> = Promise.resolve();
async function tronRead(address: string, selector: string, parameter = ""): Promise<Hex> {
  const pending = tronQueue.catch(() => {}).then(async () => {
    // TronGrid's unauthenticated endpoint allows 3 reads/second.
    await new Promise(resolve => setTimeout(resolve, 400));
    const data = await json("https://api.trongrid.io/wallet/triggerconstantcontract", {
      owner_address: `41${address.slice(-40)}`, contract_address: `41${address.slice(-40)}`,
      function_selector: selector, parameter, visible: false,
    });
    const value = data.constant_result?.[0];
    if (data.result?.result !== true || !/^[0-9a-f]{64}$/i.test(value ?? "")) throw new Error("Unsupported Tron OFT contract response.");
    return `0x${value}` as Hex;
  });
  tronQueue = pending;
  return pending;
}
async function tron(args: ReceiveStateRequest): Promise<ReceiveState> {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(args.address)) throw new Error("Invalid Tron OFT peer.");
  const token = await tronRead(args.address, "token()");
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(token)) throw new Error("Invalid Tron OFT token.");
  const shared = await tronRead(args.address, "sharedDecimals()");
  const peer = await tronRead(args.address, "peers(uint32)", args.remoteEid.toString(16).padStart(64, "0"));
  const decimals = await tronRead(token, "decimals()");
  return state(args, `0x${token.slice(-40)}`, Number(BigInt(decimals)), Number(BigInt(shared)), peer);
}

async function sui(args: ReceiveStateRequest): Promise<ReceiveState> {
  const query = async (query: string, variables: Record<string, unknown>) =>
    (await json("https://graphql.mainnet.sui.io/graphql", { query, variables })).data;
  const contents = (value: Json) => value?.asMoveObject?.contents;
  const object = async (id: string) => contents((await query(
    `query($id:SuiAddress!){object(address:$id){asMoveObject{contents{json type{repr}}}}}`, { id },
  )).object);
  const field = async (id: string, eid: number) => {
    const b = Buffer.alloc(4); b.writeUInt32LE(eid);
    return (await query(`query($id:SuiAddress!,$key:Base64!){address(address:$id){dynamicField(name:{type:"u32",bcs:$key}){value{...on MoveValue{json}}}}}`, { id, key: b.toString("base64") })).address?.dynamicField?.value?.json;
  };
  // A Sui peer is the OFT call-cap package, not the shared OFT object ID.
  const data = await query(`query($type:String!){objects(filter:{type:$type},first:2){nodes{asMoveObject{contents{json type{repr}}}} pageInfo{hasNextPage}}}`, {
    type: `${args.address}::oft::OFT<${args.token}>`,
  });
  if (data.objects?.nodes?.length !== 1 || data.objects.pageInfo.hasNextPage) throw new Error("No unambiguous Sui OFT object found for this token.");
  const oft = contents(data.objects.nodes[0])?.json;
  if (oft?.oft_cap?.cap_type?.["@variant"] !== "Package" || hexAccount(oft.oft_cap.cap_type.pos0) !== args.address)
    throw new Error("Unverified Sui OFT call capability.");
  if (oft.pausable?.paused !== false) throw new Error("The destination Sui OFT is paused or unsupported.");
  const [oapp, metadata] = await Promise.all([object(oft.oapp_object), object(oft.coin_metadata)]);
  if (oapp?.json?.oapp_cap?.cap_type?.["@variant"] !== "Package" || hexAccount(oapp.json.oapp_cap.cap_type.pos0) !== args.address)
    throw new Error("Unverified Sui OApp capability.");
  if (!nonEvmTokenMatches("SUI", metadata?.type?.repr ?? "", `0x2::coin::CoinMetadata<${args.token}>`))
    throw new Error("Unverified Sui coin metadata.");
  const peer = await field(oapp.json.peer.peers.id, args.remoteEid);
  if (typeof peer?.bytes !== "string") throw new Error("Missing Sui OFT reverse peer.");
  const peerBytes = Buffer.from(peer.bytes, "base64");
  if (peerBytes.length !== 32) throw new Error("Invalid Sui OFT reverse peer.");
  let capacity = U64_MAX;
  const limiter = oft.inbound_rate_limiter?.rate_limit_by_eid;
  if (!limiter) throw new Error("Unsupported Sui OFT receive policy.");
  if (BigInt(limiter.size) > BigInt(0)) {
    const rate = await field(limiter.id, args.remoteEid);
    if (rate) {
      // Conservative available capacity: do not assume elapsed-time refill.
      const limit = BigInt(rate.limit), used = BigInt(rate.amount_in_flight);
      capacity = limit > used ? limit - used : BigInt(0);
    }
  }
  if (oft.treasury?.["@variant"] === "Adapter") {
    // Unknown escrow layouts must not produce an executable quote.
    throw new Error("Sui escrow OFT receiving is not yet supported.");
  }
  if (oft.treasury?.["@variant"] !== "OFT") throw new Error("Unsupported Sui OFT treasury.");
  const result = state(args, args.token, metadata.json.decimals, oft.shared_decimals, toHex(peerBytes), capacity);
  if (BigInt(oft.decimal_conversion_rate) !== BigInt(10) ** BigInt(result.decimals - result.sharedDecimals))
    throw new Error("Invalid Sui OFT decimal conversion rate.");
  return result;
}

export async function readNonEvmReceiveState(args: ReceiveStateRequest): Promise<ReceiveState> {
  if (!args || !["APTOS", "STARKNET", "TRON", "SUI", "STELLAR", "TON"].includes(args.chainType) ||
    typeof args.address !== "string" || !/^0x[0-9a-f]{64}$/i.test(args.address) ||
    typeof args.token !== "string" || args.token.length > 256 ||
    typeof args.recipient !== "string" || args.recipient.length > 128 ||
    (args.amountLD !== undefined && (typeof args.amountLD !== "string" || !/^[1-9][0-9]{0,38}$/.test(args.amountLD))) ||
    !Number.isInteger(args.remoteEid) || args.remoteEid < 30000 || args.remoteEid > 0xffffffff)
    throw new Error("Invalid destination OFT validation request.");
  args = { ...args, address: hexAccount(args.address) };
  nonEvmRecipient(args.chainType, args.recipient);
  if (args.chainType === "TON") {
    const { readTonReceiveState } = await import("./direct-oft-ton");
    return readTonReceiveState(args);
  }
  if (args.chainType === "STELLAR") {
    const { readStellarReceiveState } = await import("./direct-oft-stellar");
    return readStellarReceiveState(args);
  }
  if (args.chainType === "APTOS") return aptos(args);
  if (args.chainType === "STARKNET") return starknet(args);
  if (args.chainType === "TRON") return tron(args);
  return sui(args);
}
