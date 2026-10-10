import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  unpackMint, unpackAccount, unpackMultisig, getTransferHook, getMemoTransfer,
} from "@solana/spl-token";
import { sha256, stringToBytes, toHex, type Hex } from "viem";
import type { BridgeToken } from "./bridge-types";
import type { DirectOftAdapter } from "./direct-oft-types";
import { solanaOftTokenAccountSize } from "./solana-token-extensions";
import { CONSOLE_OFT_PROGRAM_ID } from "./solana-oft-programs";

// Layout and receive semantics from usdai-foundation/solana-oft-deployment:
// programs/console_oft/src/{state/oft.rs,state/rate_limit.rs,instructions/lz_receive.rs}
// Console OFT shares OFTStore's discriminator with standard OFT but NOT its layout.
const PROGRAM = new PublicKey(CONSOLE_OFT_PROGRAM_ID);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const discriminator = (name: string) => sha256(stringToBytes(`account:${name}`)).slice(0, 18);

export class Reader {
  private offset = 8;
  constructor(private data: Uint8Array, name: string) {
    if (toHex(data.subarray(0, 8)) !== discriminator(name)) throw new Error(`Invalid Console OFT ${name} discriminator.`);
  }
  bytes(size: number) {
    if (this.offset + size > this.data.length) throw new Error("Truncated Console OFT account.");
    const bytes = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }
  u8() { return this.bytes(1)[0]; }
  bool() {
    const value = this.u8();
    if (value > 1) throw new Error("Invalid Console OFT boolean.");
    return value === 1;
  }
  view(size: number) {
    const bytes = this.bytes(size);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16() { return this.view(2).getUint16(0, true); }
  u32() { return this.view(4).getUint32(0, true); }
  u64() { return this.view(8).getBigUint64(0, true); }
  key() { return new PublicKey(this.bytes(32)); }
  end(allocatedPadding = 0) {
    if (this.data.length - this.offset <= allocatedPadding) return;
    // Anchor allocates max Vec capacity; remaining bytes are zero padding.
    if (this.data.subarray(this.offset).some((byte) => byte !== 0)) throw new Error("Unsupported Console OFT account layout.");
  }
}

export function decodeConsoleOftStore(data: Uint8Array) {
  const r = new Reader(data, "OFTStore");
  const type = r.u8();
  if (type > 1) throw new Error("Unsupported Console OFT type.");
  const rate = r.u64(), sharedDecimals = r.u8(), mint = r.key(), initializer = r.key();
  const tokenProgram = r.key(), bump = r.u8(), hook = r.key();
  const count = r.u32();
  if (count > 10) throw new Error("Invalid Console OFT lookup tables.");
  const alts = Array.from({ length: count }, () => r.key());
  r.key(); r.key(); // current/pending admin
  const paused = r.bool(), feeBps = r.u16(), feeDeposit = r.key();
  const useGlobalState = r.bool(), globallyDisabled = r.bool();
  r.end();
  return { type, rate, sharedDecimals, mint, initializer, tokenProgram, bump, hook, alts, paused, feeBps, feeDeposit, useGlobalState, globallyDisabled };
}

export function decodeConsoleRateLimit(data: Uint8Array) {
  const r = new Reader(data, "RateLimit");
  const result = {
    override: r.bool(), outbound: r.bool(), inbound: r.bool(), net: r.bool(), exempt: r.bool(),
    outboundLimit: r.u64(), inboundLimit: r.u64(), outboundWindow: r.u64(), inboundWindow: r.u64(),
    outboundUsage: r.u64(), inboundUsage: r.u64(), updatedAt: r.u64(),
  };
  r.end();
  return result;
}
type Rate = ReturnType<typeof decodeConsoleRateLimit>;

// Mirrors apply_rate_limit's INBOUND branch. Use the chain clock, not client time.
export function consoleInboundCapacity(store: { useGlobalState: boolean; globallyDisabled: boolean },
  defaults: Rate, route: Rate | null, exempt: boolean, now: bigint): bigint {
  if (store.globallyDisabled) return U64_MAX;
  const state = store.useGlobalState ? defaults : route;
  const config = store.useGlobalState || !route?.override ? defaults : route;
  if ((!config.inbound && (!config.outbound || !config.net)) || (config.exempt && exempt)) return U64_MAX;
  if (!state) throw new Error("Console OFT destination rate limit is not initialized.");
  if (now < state.updatedAt) throw new Error("Console OFT rate-limit timestamp is ahead of the chain clock.");
  if (!config.inbound) return U64_MAX;
  const decay = config.inboundLimit * (now - state.updatedAt) / (config.inboundWindow || BigInt(1));
  const usage = state.inboundUsage > decay ? state.inboundUsage - decay : BigInt(0);
  return config.inboundLimit > usage ? config.inboundLimit - usage : BigInt(0);
}

const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM);
const seed = stringToBytes;
function be(value: number, size: number) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(size - 4, value);
  return bytes;
}
function owned(account: AccountInfo<Buffer> | null, name: string): AccountInfo<Buffer> {
  if (!account || account.executable || !account.owner.equals(PROGRAM)) throw new Error(`Invalid Console OFT ${name} account owner.`);
  return account;
}

export async function createConsoleOftReceiveAdapter(args: {
  connection: Connection; storeKey: PublicKey; storeRaw: AccountInfo<Buffer>;
  token: BridgeToken; remoteEid: number; from?: string; simulate?: boolean;
  rentOptions: (rent: bigint, enforced: Hex) => Hex;
}): Promise<DirectOftAdapter> {
  const { connection, storeKey } = args;
  const store = decodeConsoleOftStore(owned(args.storeRaw, "store").data);
  const [expectedStore, bump] = pda(seed("OFT"), store.initializer.toBytes());
  if (!expectedStore.equals(storeKey) || bump !== store.bump) throw new Error("Invalid Console OFT store PDA.");
  if (store.mint.toBase58() !== args.token.address) throw new Error("Console OFT mint does not match the selected token.");
  if (!store.tokenProgram.equals(TOKEN_PROGRAM_ID) && !store.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Unsupported Console OFT token program.");
  const [peerKey, peerBump] = pda(seed("Peer"), storeKey.toBytes(), be(args.remoteEid, 4));
  const [escrowKey] = pda(seed("Escrow"), storeKey.toBytes());
  const [programRaw, mintRaw, peerRaw, escrowRaw] = await connection.getMultipleAccountsInfo([PROGRAM, store.mint, peerKey, escrowKey]);
  if (!programRaw?.executable) throw new Error("Console OFT program is not executable.");
  if (!peerRaw) throw new Error(`No Console OFT peer is configured for endpoint ${args.remoteEid}; this direct route is not available on chain.`);
  const peerReader = new Reader(owned(peerRaw, "peer").data, "OAppPeer");
  const peer = toHex(peerReader.bytes(32));
  if (/^0x0{64}$/.test(peer) || peerReader.u8() !== peerBump) throw new Error("Invalid Console OFT peer.");
  peerReader.end();
  const mint = unpackMint(store.mint, mintRaw, store.tokenProgram);
  if (!mint.isInitialized || mint.decimals !== args.token.decimals || store.sharedDecimals > mint.decimals ||
      store.rate !== BigInt(10) ** BigInt(mint.decimals - store.sharedDecimals)) throw new Error("Invalid Console OFT decimal configuration.");
  // Disabled hooks (sUSDai's current deployment) are supported; active hooks
  // remain rejected until their own implementation has a reviewed adapter.
  const hook = getTransferHook(mint)?.programId ?? PublicKey.default;
  if (!hook.equals(store.hook)) throw new Error("Console OFT transfer-hook configuration is out of sync.");
  const accountSize = solanaOftTokenAccountSize(mint, store.tokenProgram);
  const escrow = unpackAccount(escrowKey, escrowRaw, store.tokenProgram);
  if (!escrow.mint.equals(store.mint) || !escrow.owner.equals(storeKey) || !escrow.isInitialized || escrow.isFrozen || getMemoTransfer(escrow)?.requireIncomingTransferMemos)
    throw new Error("Invalid Console OFT escrow token account.");
  if (store.type === 0) {
    if (!mint.mintAuthority) throw new Error("Console OFT mint authority is missing.");
    if (!mint.mintAuthority.equals(storeKey)) {
      const authority = unpackMultisig(mint.mintAuthority, await connection.getAccountInfo(mint.mintAuthority), store.tokenProgram);
      const signers = [authority.signer1, authority.signer2, authority.signer3, authority.signer4, authority.signer5,
        authority.signer6, authority.signer7, authority.signer8, authority.signer9, authority.signer10, authority.signer11].slice(0, authority.n);
      if (!authority.isInitialized || authority.m !== 1 || authority.n < 1 || authority.n > 11 || !signers.some((key) => key.equals(storeKey)))
        throw new Error("Console OFT requires a valid 1-of-n mint authority containing the store.");
    }
  }
  const lookups = await Promise.all(store.alts.map(async (key) => (await connection.getAddressLookupTable(key)).value));
  if (lookups.some((table) => !table?.isActive())) throw new Error("Console OFT receive lookup table is unavailable.");
  const unsupportedSource = async (): Promise<never> => { throw new Error("Solana source wallet is required."); };
  const source = args.from ? await (await import("./direct-oft-solana-console-send")).createConsoleOftSource({
    connection, storeKey, store, peerKey, peer, escrowKey, lookups: lookups.filter((table) => table !== null),
    from: args.from, remoteEid: args.remoteEid, simulate: args.simulate ?? false,
  }) : null;
  return {
    addressBytes32: toHex(storeKey.toBytes()), tokenAddress: store.mint.toBase58(),
    decimals: mint.decimals, sharedDecimals: store.sharedDecimals, peer, enforcedOptions: "0x",
    receiveOptions: async (recipient, enforced) => {
      const owner = new PublicKey(recipient);
      const ata = getAssociatedTokenAddressSync(store.mint, owner, true, store.tokenProgram);
      const raw = await connection.getAccountInfo(ata);
      if (raw) {
        const token = unpackAccount(ata, raw, store.tokenProgram);
        if (!token.owner.equals(owner) || !token.mint.equals(store.mint) || !token.isInitialized || token.isFrozen || getMemoTransfer(token)?.requireIncomingTransferMemos)
          throw new Error("Destination Console OFT token account is invalid, frozen, or requires a memo.");
        return "0x";
      }
      const rent = BigInt(await connection.getMinimumBalanceForRentExemption(accountSize));
      return args.rentOptions(rent, enforced);
    },
    validateReceive: async (recipient, amount) => {
      if (amount <= BigInt(0) || amount > U64_MAX || (store.type === 0 && mint.supply + amount > U64_MAX)) throw new Error("Console OFT receive amount exceeds mint limits.");
      if (store.type === 1 && escrow.amount < amount) throw new Error("Console OFT destination escrow has insufficient liquidity.");
      const defaultKey = pda(seed("RateLimit"), storeKey.toBytes(), be(0, 16))[0];
      const rateKey = pda(seed("RateLimit"), storeKey.toBytes(), be(args.remoteEid, 16))[0];
      const exemptKey = pda(seed("RateLimitExemption"), storeKey.toBytes(), new PublicKey(recipient).toBytes())[0];
      const [defaultRaw, routeRaw, exemptRaw, clock] = await connection.getMultipleAccountsInfo([defaultKey, rateKey, exemptKey, SYSVAR_CLOCK_PUBKEY]);
      const defaults = decodeConsoleRateLimit(owned(defaultRaw, "default rate limit").data);
      const route = routeRaw?.data.length ? decodeConsoleRateLimit(owned(routeRaw, "rate limit").data) : null;
      const exempt = Boolean(exemptRaw?.data.length);
      if (exempt) {
        const r = new Reader(owned(exemptRaw, "exemption").data, "RateLimitAddressExemption");
        if (!r.bool()) throw new Error("Invalid Console OFT rate-limit exemption.");
        r.end();
      }
      if (!clock || clock.data.length !== 40) throw new Error("Solana chain clock is unavailable.");
      const now = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigInt64(32, true);
      if (amount > consoleInboundCapacity(store, defaults, route, exempt, now)) throw new Error("Amount exceeds the Console OFT destination receive limit. Try a smaller amount or wait for capacity to recover.");
    },
    quoteOft: unsupportedSource, quoteSend: unsupportedSource, buildSteps: unsupportedSource,
    ...source,
  };
}

// Burn/mint Console stores are signers of the mint authority (often a 1-of-n
// Token-2022 multisig). Follow those accounts instead of getProgramAccounts:
// public RPCs commonly reject indexed queries even when normal reads work.
export async function discoverConsoleOftStores(rpcUrl: string, mintAddress: string): Promise<string[]> {
  const connection = new Connection(rpcUrl, "confirmed"), mintKey = new PublicKey(mintAddress);
  const mintRaw = await connection.getAccountInfo(mintKey);
  if (!mintRaw || (!mintRaw.owner.equals(TOKEN_PROGRAM_ID) && !mintRaw.owner.equals(TOKEN_2022_PROGRAM_ID))) return [];
  const mint = unpackMint(mintKey, mintRaw, mintRaw.owner);
  if (!mint.mintAuthority) return [];
  const authorityRaw = await connection.getAccountInfo(mint.mintAuthority);
  let candidates = [mint.mintAuthority];
  if (authorityRaw?.owner.equals(mintRaw.owner)) {
    const authority = unpackMultisig(mint.mintAuthority, authorityRaw, mintRaw.owner);
    if (!authority.isInitialized || authority.m !== 1 || authority.n < 1 || authority.n > 11) return [];
    candidates = [authority.signer1, authority.signer2, authority.signer3, authority.signer4, authority.signer5,
      authority.signer6, authority.signer7, authority.signer8, authority.signer9, authority.signer10, authority.signer11].slice(0, authority.n);
  }
  const accounts = await connection.getMultipleAccountsInfo(candidates);
  return candidates.filter((_, index) => {
    const account = accounts[index];
    return account && !account.executable && account.owner.equals(PROGRAM) &&
      toHex(account.data.subarray(0, 8)) === discriminator("OFTStore") && decodeConsoleOftStore(account.data).mint.equals(mintKey);
  }).map((key) => key.toBase58());
}
