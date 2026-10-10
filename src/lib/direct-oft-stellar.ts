// The Stellar SDK stays on the server. Every operation below is an unsigned
// Soroban simulation or ledger read; no transaction is ever submitted here.
import { Account, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";
import type { ReceiveState, ReceiveStateRequest } from "./direct-oft-receive";
import { stellarAddressBytes32, stellarContractAddress } from "./stellar-address";

const READ_ACCOUNT = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const server = () => new rpc.Server("https://soroban-rpc.mainnet.stellar.gateway.fm", { timeout: 15 });
let reads: Promise<unknown> = Promise.resolve();
function pacedRead<T>(read: () => Promise<T>): Promise<T> {
  const pending = reads.catch(() => {}).then(async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    return read();
  });
  reads = pending;
  return pending;
}
const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);

export async function readStellarReceiveState(args: ReceiveStateRequest): Promise<ReceiveState> {
  const client = server();
  const contract = stellarContractAddress(args.address);
  const recipientPayload = stellarAddressBytes32(args.recipient);
  stellarAddressBytes32(args.token, "contract");
  const read = async (address: string, method: string, params: xdr.ScVal[] = []) => {
    const transaction = new TransactionBuilder(new Account(READ_ACCOUNT, "0"), { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(new Contract(address).call(method, ...params)).setTimeout(30).build();
    const result = await pacedRead(() => client.simulateTransaction(transaction));
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
      const message = "error" in result ? result.error : "missing result";
      if (/trustline entry is missing/i.test(message)) throw new Error("Add a trustline for the selected token in your Stellar destination wallet before bridging.");
      throw new Error(`Stellar ${method} validation failed: ${message.slice(0, 250)}`);
    }
    return scValToNative(result.result.retval);
  };
  const eid = nativeToScVal(args.remoteEid, { type: "u32" });
  const inbound = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Inbound")]);
  const [token, shared, peer, paused, oftType, capacity, entries] = await Promise.all([
    read(contract, "token"), read(contract, "shared_decimals"), read(contract, "peer", [eid]), read(contract, "is_paused"),
    read(contract, "oft_type"), read(contract, "rate_limit_capacity", [inbound, eid]),
    pacedRead(() => client.getLedgerEntries(new Contract(stellarContractAddress(recipientPayload)).getFootprint())),
  ]);
  if (token !== args.token) throw new Error("Destination Stellar OFT token does not match the selected asset.");
  if (paused !== false) throw new Error("The destination Stellar OFT is paused.");
  if (!(peer instanceof Uint8Array) || peer.length !== 32) throw new Error("Missing Stellar OFT reverse peer.");
  // OFT resolves a payload to C if that contract exists, otherwise to G. Do not
  // silently change the address type the user selected.
  const contractExists = entries.entries.length > 0;
  if (args.recipient.startsWith("C") !== contractExists)
    throw new Error("Stellar recipient resolves to a different address type. Use an existing C contract or a G account without a conflicting contract payload.");
  if (!Array.isArray(oftType) || !["MintBurn", "LockUnlock"].includes(oftType[0])) throw new Error("Unsupported Stellar OFT credit implementation.");
  const decimals = await read(token, "decimals");
  let maxAmount = BigInt(capacity);
  if (oftType[0] === "LockUnlock") {
    const balance = BigInt(await read(token, "balance", [nativeToScVal(contract, { type: "address" })]));
    if (balance < maxAmount) maxAmount = balance;
  }
  if (!Number.isInteger(decimals) || !Number.isInteger(shared) || shared < 0 || decimals < shared || decimals > 255 || maxAmount < BigInt(0) || maxAmount > I128_MAX)
    throw new Error("Invalid Stellar OFT decimals or receive capacity.");
  const amount = args.amountLD ? BigInt(args.amountLD) : BigInt(1);
  if (amount > maxAmount || amount > I128_MAX) throw new Error("Amount exceeds the Stellar OFT receive capacity.");
  const to = nativeToScVal(args.recipient, { type: "address" });
  const quantity = nativeToScVal(amount, { type: "i128" });
  const operator = nativeToScVal(contract, { type: "address" });
  if (oftType[0] === "MintBurn") {
    if (typeof oftType[1] !== "string") throw new Error("Invalid Stellar OFT minter.");
    stellarAddressBytes32(oftType[1], "contract");
    await read(oftType[1], "mint", [to, quantity, operator]);
  } else {
    await read(token, "transfer", [operator, to, quantity]);
  }
  return { addressBytes32: args.address, tokenAddress: token, decimals, sharedDecimals: shared, peer: toHex(peer), maxAmountLD: maxAmount.toString() };
}
