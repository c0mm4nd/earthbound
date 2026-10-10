import { keccak256, type Address, type Hex } from "viem";
import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import type { Buffer } from "buffer";

// Reviewed sources: OrderlyNetwork/solana-proxy at
// 3eeaf4a0103d39d7e7814482c95c58fb6000ba3a, programs/oft/src/msg_codec.rs;
// verified EVM implementations ccb20d... (Ethereum) and b04d10... (Base).
// ORDER uses a uint256 / 18-decimal wire amount. Solana scales by 10^8.
export const ORDERLY_SOLANA_PROGRAM = "GZGX6QfUo62VbPyYqPZS6t27Uke1dJmoAP6V3rw6ntTH";
export const ORDERLY_SOLANA_MINT = "ABt79MkRXUsoHuV2CVQT32YMXQhTparKFjmidQxgiQ6E";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAM_DATA = new PublicKey("84iYLUvVSzgdGyn3js3RnrfiCwLmfYwWLtHXr6daAoM");
export const ORDERLY_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_HASH = "0x0959a24babb02d4d6c6ef27aaec9c34e824a2c55d24b13a8b3dae8401138e1c4";
const IMPL_HASH = {
  adapter: "0xe6e2b7287c9c7dbac3f27e6012c00c65213fc440ae25262b620851da20abe2dc",
  oft: "0x614a3b09b154cb5eaf276e13795caee3b24f2e12a9b862b85dbbe2eab0221d0e",
};
const DEPLOYMENTS: Record<number, string> = {
  1: "0x17435cc940e03aa52c349738c72c7aa44ffa6525",
  8453: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
  42161: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
  56: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
  10: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
  137: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
  2741: "0x9a4c8cd493cf0bf8e14bda5890e3f03a1cded719",
  43114: "0x4e200fe2f3efb977d5fd9c430a41531fb04d97b8",
};

export async function verifyOrderlyEvm(args: {
  chainId: number; address: Address; readCode?: (address: Address) => Promise<Hex | undefined>;
  readStorage?: (address: Address, slot: Hex) => Promise<Hex | undefined>;
}) {
  if (DEPLOYMENTS[args.chainId] !== args.address.toLowerCase()) return false;
  if (!args.readCode || !args.readStorage) throw new Error("ORDER contract implementation cannot be verified.");
  const [proxy, slot] = await Promise.all([args.readCode(args.address), args.readStorage(args.address, ORDERLY_IMPLEMENTATION_SLOT)]);
  if (!proxy || keccak256(proxy) !== PROXY_HASH || !slot || !/^0x0{24}[0-9a-f]{40}$/i.test(slot))
    throw new Error("ORDER proxy implementation changed or is invalid.");
  const implementation = await args.readCode(`0x${slot.slice(-40)}`);
  if (!implementation || keccak256(implementation) !== IMPL_HASH[args.chainId === 1 ? "adapter" : "oft"])
    throw new Error("ORDER implementation has changed and must be reviewed.");
  return true;
}

export async function verifyOrderlySolana(connection: Connection, program: PublicKey, raw: AccountInfo<Buffer>) {
  if (program.toBase58() !== ORDERLY_SOLANA_PROGRAM) return false;
  if (!raw.executable || !raw.owner.equals(LOADER) || raw.data.length !== 36 || raw.data.readUInt32LE(0) !== 2 ||
      !new PublicKey(raw.data.subarray(4, 36)).equals(PROGRAM_DATA)) throw new Error("Invalid ORDER Solana program.");
  // Every upgrade changes this loader-owned slot. Read only the header; do not
  // download the entire ELF on every quote. Reviewed ELF SHA-256:
  // 2c850184c0ab3e407b03b3f11837bb615597038b062decac1a8d6fb31ace7e4a
  const data = await connection.getAccountInfo(PROGRAM_DATA, { commitment: "confirmed", dataSlice: { offset: 0, length: 45 } });
  if (!data || !data.owner.equals(LOADER) || data.data.length < 12 || data.data.readUInt32LE(0) !== 3 ||
      data.data.readBigUInt64LE(4) !== BigInt(302587384)) throw new Error("ORDER Solana program was upgraded and must be reviewed.");
  return true;
}

export function orderlyAmount(amount: bigint, sourceDecimals: number, destinationDecimals: number) {
  if (![10, 18].includes(sourceDecimals) || ![10, 18].includes(destinationDecimals)) throw new Error("Unsupported ORDER decimals.");
  if (amount < BigInt(0) || amount >= BigInt(1) << BigInt(sourceDecimals === 10 ? 64 : 256)) throw new Error("ORDER source amount exceeds integer limits.");
  const received = amount * BigInt(10) ** BigInt(destinationDecimals) / BigInt(10) ** BigInt(sourceDecimals);
  if (received >= BigInt(1) << BigInt(destinationDecimals === 10 ? 64 : 256)) throw new Error("ORDER destination amount exceeds integer limits.");
  return received;
}
