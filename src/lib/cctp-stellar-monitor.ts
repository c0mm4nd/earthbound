import { Account, Contract, Networks, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { toHex, type Hex } from "viem";
import { CCTP_STELLAR, isCctpNativeHash } from "./cctp-native";

export const CCTP_STELLAR_RPC = "https://soroban-rpc.mainnet.stellar.gateway.fm";
type ReadServer = Pick<rpc.Server, "getNetwork" | "simulateTransaction" | "getTransaction">;
export function createCctpStellarMonitor(server: ReadServer = new rpc.Server(CCTP_STELLAR_RPC)) {
  async function mainnet() {
    if ((await server.getNetwork()).passphrase !== Networks.PUBLIC) throw new Error("CCTP requires Stellar mainnet.");
  }
  async function view(name: string, args: xdr.ScVal[] = []) {
    // Read-only simulation: the existing public issuer account is only the
    // simulation source. This transaction is never signed or broadcast.
    const account = new Account("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "0");
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(new Contract(CCTP_STELLAR.transmitter).call(name, ...args)).setTimeout(60).build();
    const result = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) throw new Error("Stellar CCTP state simulation failed.");
    return scValToNative(result.result.retval) as unknown;
  }
  return {
    async receipt(hash: string, includeMessage = false): Promise<{ state: "pending" | "failed" | "confirmed"; message?: Hex }> {
      if (!isCctpNativeHash(27, hash)) throw new Error("Invalid Stellar CCTP transaction hash.");
      await mainnet();
      const tx = await server.getTransaction(hash);
      if (tx.txHash.toLowerCase() !== hash.toLowerCase()) throw new Error("Stellar receipt hash mismatch.");
      if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { state: "pending" };
      if (tx.status === rpc.Api.GetTransactionStatus.FAILED) return { state: "failed" };
      const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr, Networks.PUBLIC);
      if (Buffer.from(envelope.hash()).toString("hex") !== hash.toLowerCase()) throw new Error("Stellar envelope hash mismatch.");
      if (!includeMessage) return { state: "confirmed" };
      const events = tx.events.contractEventsXdr.flat().filter(e => e.type.name === "contract" && e.contractId &&
        StrKey.encodeContract(e.contractId.value) === CCTP_STELLAR.transmitter && e.body.v0.topics.length === 1 &&
        scValToNative(e.body.v0.topics[0]) === "message_sent");
      if (events.length !== 1) throw new Error("Expected one Circle Stellar message_sent event.");
      const data: unknown = scValToNative(events[0].body.v0.data);
      const bytes = data && typeof data === "object" && "message" in data ? data.message : undefined;
      if (!(bytes instanceof Uint8Array) || bytes.length < 376 || bytes.length > 8192) throw new Error("Invalid Stellar Circle message bytes.");
      return { state: "confirmed", message: toHex(bytes) };
    },
    async attesters() {
      await mainnet();
      const [domain, version, thresholdValue, countValue] = await Promise.all([view("get_local_domain"), view("get_version"), view("get_signature_threshold"), view("get_num_enabled_attesters")]);
      const threshold = Number(thresholdValue), count = Number(countValue);
      if (domain !== 27 || version !== 1 || !Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > count) throw new Error("Invalid Stellar CCTP deployment or attester set.");
      const enabled = await Promise.all(Array.from({ length: count }, (_, i) => view("get_enabled_attester", [nativeToScVal(i, { type: "u32" })])));
      if (!enabled.every(a => a instanceof Uint8Array && a.length === 20)) throw new Error("Invalid Stellar attester address.");
      return { domain: 27, threshold, enabledAttesters: enabled.map(a => toHex(a as Uint8Array)) };
    },
    async nonceUsed(nonce: Hex) {
      if (!/^0x[\da-f]{64}$/i.test(nonce) || BigInt(nonce) === BigInt(0)) throw new Error("Invalid CCTP nonce.");
      await mainnet(); const used = await view("is_nonce_used", [xdr.ScVal.scvBytes(Buffer.from(nonce.slice(2), "hex"))]);
      if (typeof used !== "boolean") throw new Error("Invalid Stellar nonce response.");
      return used;
    },
  };
}
