import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { CCTP_STARKNET, cctpCairoUint256, decodeCctpCairoBytes } from "./cctp-starknet";
import { isCctpNativeHash } from "./cctp-native";
const selector = (name: string) => toHex(BigInt(keccak256(stringToHex(name))) & (BigInt(2) ** BigInt(250) - BigInt(1)));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Starknet RPC object.");
  return value as Record<string, unknown>;
};
export function createCctpStarknetMonitor(fetcher: typeof fetch = fetch) {
  async function rpc(method: string, params: unknown, missing = false): Promise<unknown> {
    const response = await fetcher("https://starknet-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Starknet RPC unavailable (HTTP ${response.status}).`);
    const data = record(await response.json());
    if (data.error) {
      if (missing && record(data.error).code === 29) return null; // TRANSACTION_HASH_NOT_FOUND
      throw new Error("Starknet CCTP RPC request failed.");
    }
    return data.result;
  }
  async function mainnet() { if (await rpc("starknet_chainId", []) !== "0x534e5f4d41494e") throw new Error("CCTP requires Starknet mainnet."); }
  async function viewValues(name: string, calldata: string[] = []) {
    const result = await rpc("starknet_call", { request: { contract_address: CCTP_STARKNET.transmitter, entry_point_selector: selector(name), calldata }, block_id: "latest" });
    if (!Array.isArray(result) || !result.every(v => typeof v === "string" && /^0x[\da-f]+$/i.test(v))) throw new Error("Invalid Starknet CCTP view response.");
    return result.map(v => BigInt(v as string));
  }
  async function view(name: string, calldata: string[] = []) {
    const values = await viewValues(name, calldata);
    if (values.length !== 1) throw new Error("Invalid Starknet scalar response.");
    return values[0];
  }
  return {
    async receipt(hash: string, includeMessage = false): Promise<{ state: "pending" | "failed" | "confirmed"; message?: Hex }> {
      if (!isCctpNativeHash(25, hash)) throw new Error("Invalid Starknet CCTP transaction hash.");
      await mainnet();
      const value = await rpc("starknet_getTransactionReceipt", { transaction_hash: hash }, true);
      if (!value) return { state: "pending" };
      const tx = record(value);
      if (typeof tx.transaction_hash !== "string" || BigInt(tx.transaction_hash) !== BigInt(hash)) throw new Error("Starknet receipt hash mismatch.");
      if (tx.execution_status === "REVERTED") return { state: "failed" };
      if (tx.execution_status !== "SUCCEEDED" || !["ACCEPTED_ON_L1", "ACCEPTED_ON_L2"].includes(String(tx.finality_status))) return { state: "pending" };
      if (!includeMessage) return { state: "confirmed" };
      const matches = (Array.isArray(tx.events) ? tx.events : []).map(record).filter(e => typeof e.from_address === "string" && BigInt(e.from_address) === BigInt(CCTP_STARKNET.transmitter) &&
        Array.isArray(e.keys) && e.keys.length === 1 && typeof e.keys[0] === "string" && BigInt(e.keys[0]) === BigInt(selector("MessageSent")));
      if (matches.length !== 1 || !Array.isArray(matches[0].data)) throw new Error("Expected one Circle Starknet MessageSent event.");
      return { state: "confirmed", message: decodeCctpCairoBytes(matches[0].data as string[]) };
    },
    async attesters() {
      await mainnet();
      const [domain, version, threshold, attesters] = await Promise.all([view("get_local_domain"), view("get_version"), view("get_signature_threshold"), viewValues("get_enabled_attesters")]);
      const [count, ...enabled] = attesters;
      if (domain !== BigInt(25) || version !== BigInt(1) || threshold < BigInt(1) || threshold > count || count > BigInt(100)) throw new Error("Invalid Starknet CCTP deployment or attester set.");
      if (enabled.length !== Number(count)) throw new Error("Invalid Starknet attester array.");
      if (enabled.some(a => a <= BigInt(0) || a >= BigInt(2) ** BigInt(160))) throw new Error("Invalid Starknet attester address.");
      return { domain: 25, threshold: Number(threshold), enabledAttesters: enabled.map(a => toHex(a)) };
    },
    async nonceUsed(nonce: Hex) {
      if (!/^0x[\da-f]{64}$/i.test(nonce) || BigInt(nonce) === BigInt(0)) throw new Error("Invalid CCTP nonce.");
      await mainnet(); const used = await view("is_nonce_used", cctpCairoUint256(BigInt(nonce)));
      if (used !== BigInt(0) && used !== BigInt(1)) throw new Error("Invalid Starknet nonce response.");
      return used === BigInt(1);
    },
  };
}
