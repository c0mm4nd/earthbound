import { toHex, type Hex } from "viem";
import { CCTP_SUI } from "./cctp-sui";
import { isCctpNativeHash } from "./cctp-native";

export const CCTP_APTOS_MT = "0x1b3f6d749cb835451202f9a1932e49014266f7e3d51611a9a763d156cb4bdaf6";
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CCTP RPC object.");
  return value as Record<string, unknown>;
};
const one = (value: unknown) => { if (!Array.isArray(value) || value.length !== 1) throw new Error("Invalid CCTP view response."); return value[0]; };
function messageBytes(value: unknown): Hex {
  if (typeof value === "string" && /^0x(?:[\da-f]{2}){376,8192}$/i.test(value)) return value.toLowerCase() as Hex;
  if (Array.isArray(value) && value.length >= 376 && value.length <= 8192 && value.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return toHex(new Uint8Array(value));
  throw new Error("Invalid Circle Move message bytes.");
}
export function decodeCctpSuiState(value: unknown) {
  const data = record(record(value).data), content = record(data.content), fields = record(content.fields);
  if (data.objectId !== CCTP_SUI.transmitterState || content.type !== `${CCTP_SUI.transmitter}::state::State` ||
      fields.local_domain !== 8 || fields.message_version !== 1 || fields.paused !== false) throw new Error("Wrong or unavailable Sui CCTP transmitter.");
  const enabled = record(record(fields.enabled_attesters).fields).contents;
  const threshold = Number(fields.signature_threshold);
  if (!Array.isArray(enabled) || !enabled.every(a => typeof a === "string" && /^0x0{24}[\da-f]{40}$/i.test(a)) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > enabled.length || enabled.length > 100) throw new Error("Invalid Sui CCTP attester set.");
  const nonceTable = record(record(record(fields.used_nonces).fields).id).id;
  if (typeof nonceTable !== "string" || !/^0x[\da-f]{64}$/i.test(nonceTable)) throw new Error("Invalid Sui nonce table.");
  return { domain: 8, threshold, enabledAttesters: enabled as string[], nonceTable };
}

/** Concrete read-only adapters. A confirmed receipt is distinct from delivery. */
export function createCctpMoveMonitor(domain: 8 | 9, fetcher: typeof fetch = fetch) {
  if (domain !== 8 && domain !== 9) throw new Error("Unsupported CCTP Move domain.");
  const aptos = "https://fullnode.mainnet.aptoslabs.com/v1", sui = "https://sui-rpc.publicnode.com";
  async function json(url: string, body?: unknown, missing = false) {
    const response = await fetcher(url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`CCTP RPC unavailable (HTTP ${response.status}).`);
    return response.json() as Promise<unknown>;
  }
  async function rpc(method: string, params: unknown[]) {
    const response = record(await json(sui, { jsonrpc: "2.0", id: 1, method, params }));
    if (response.error) throw new Error("Sui CCTP RPC request failed.");
    return response.result;
  }
  async function mainnet() {
    if (domain === 9) {
      if (record(await json(aptos)).chain_id !== 1) throw new Error("CCTP requires Aptos mainnet.");
    } else if (await rpc("sui_getChainIdentifier", []) !== "35834a8a") throw new Error("CCTP requires Sui mainnet.");
  }
  const view = async (module: string, fn: string, args: string[] = []) => one(await json(`${aptos}/view`, { function: `${CCTP_APTOS_MT}::${module}::${fn}`, type_arguments: [], arguments: args }));
  async function suiState() { return decodeCctpSuiState(await rpc("sui_getObject", [CCTP_SUI.transmitterState, { showContent: true }])); }
  return {
    async receipt(hash: string, includeMessage = false): Promise<{ state: "pending" | "failed" | "confirmed"; message?: Hex }> {
      if (!isCctpNativeHash(domain, hash)) throw new Error("Invalid CCTP Move transaction hash.");
      await mainnet();
      let events: unknown[];
      if (domain === 9) {
        const raw = await json(`${aptos}/transactions/by_hash/${hash}`, undefined, true);
        if (!raw) return { state: "pending" };
        const tx = record(raw);
        if (typeof tx.hash !== "string" || tx.hash.toLowerCase() !== hash.toLowerCase()) throw new Error("Aptos receipt hash mismatch.");
        if (tx.type === "pending_transaction") return { state: "pending" };
        if (tx.type !== "user_transaction" || typeof tx.success !== "boolean") throw new Error("Invalid Aptos receipt.");
        if (!tx.success) return { state: "failed" };
        events = Array.isArray(tx.events) ? tx.events : [];
      } else {
        const result = record(await rpc("sui_getTransactionBlock", [hash, { showEffects: true, showEvents: includeMessage }]));
        if (result.digest !== hash) throw new Error("Sui receipt digest mismatch.");
        const state = record(record(result.effects).status).status;
        if (state === "failure") return { state: "failed" };
        if (state !== "success") throw new Error("Invalid Sui transaction effects.");
        events = Array.isArray(result.events) ? result.events : [];
      }
      if (!includeMessage) return { state: "confirmed" };
      const type = domain === 9 ? `${CCTP_APTOS_MT}::message_transmitter::MessageSent` : `${CCTP_SUI.transmitter}::send_message::MessageSent`;
      const matches = events.map(record).filter(event => event.type === type);
      if (matches.length !== 1) throw new Error("Expected one Circle message from the official Move package.");
      return { state: "confirmed", message: messageBytes(record(domain === 9 ? matches[0].data : matches[0].parsedJson).message) };
    },
    async attesters() {
      await mainnet();
      if (domain === 8) return suiState();
      const [local, version, thresholdValue, countValue] = await Promise.all([
        view("message_transmitter", "local_domain"), view("message_transmitter", "version"),
        view("attester", "get_signature_threshold"), view("attester", "get_num_enabled_attesters"),
      ]);
      const threshold = Number(thresholdValue), count = Number(countValue);
      if (Number(local) !== 9 || Number(version) !== 1 || !Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > count) throw new Error("Invalid Aptos CCTP deployment or attester set.");
      const enabled = await Promise.all(Array.from({ length: count }, (_, i) => view("attester", "get_enabled_attester", [String(i)])));
      if (!enabled.every(a => typeof a === "string" && /^0x[\da-f]{1,64}$/i.test(a) && BigInt(a) < BigInt(2) ** BigInt(160))) throw new Error("Invalid Aptos attester address.");
      return { domain: 9, threshold, enabledAttesters: enabled as string[] };
    },
    async nonceUsed(nonce: Hex) {
      if (!/^0x[\da-f]{64}$/i.test(nonce) || BigInt(nonce) === BigInt(0)) throw new Error("Invalid CCTP nonce.");
      await mainnet();
      if (domain === 9) {
        const used = await view("message_transmitter", "is_nonce_used", [BigInt(nonce).toString()]);
        if (typeof used !== "boolean") throw new Error("Invalid Aptos nonce response.");
        return used;
      }
      const { nonceTable } = await suiState();
      const result = record(await rpc("suix_getDynamicFieldObject", [nonceTable, { type: "u256", value: BigInt(nonce).toString() }]));
      if (result.error && record(result.error).code === "dynamicFieldNotFound") return false;
      const content = record(record(result.data).content), fields = record(content.fields);
      if (content.type !== "0x2::dynamic_field::Field<u256, bool>" || String(fields.name) !== BigInt(nonce).toString() || fields.value !== true) throw new Error("Invalid Sui consumed-nonce object.");
      return true;
    },
  };
}
