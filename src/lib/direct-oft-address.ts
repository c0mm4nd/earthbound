import { stellarAddressBytes32 } from "./stellar-address";
import { padHex, sha256, toHex, type Hex } from "viem";

export function hexAccount(address: string, bits = 256): Hex {
  if (!/^0x[0-9a-f]{1,64}$/i.test(address) || BigInt(address) <= BigInt(0) || BigInt(address) >= (BigInt(1) << BigInt(bits)))
    throw new Error("Invalid direct OFT account address.");
  // Starknet ContractAddress uses an upper bound stricter than felt252.
  if (bits === 251 && BigInt(address) >= (BigInt(1) << BigInt(251)) - BigInt(256)) throw new Error("Invalid Starknet account address.");
  return padHex(address.toLowerCase() as Hex, { size: 32 });
}

export function tronAccount(address: string): Hex {
  if (/^0x(?:0{24})?[0-9a-f]{40}$/i.test(address)) return hexAccount(address);
  if (/^(0x)?41[0-9a-f]{40}$/i.test(address)) return hexAccount(`0x${address.replace(/^0x/i, "").slice(2)}`);
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new Error("Invalid Tron address.");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(0);
  for (const c of address) n = n * BigInt(58) + BigInt(alphabet.indexOf(c));
  const hex = n.toString(16).padStart(50, "0");
  const body = `0x${hex.slice(0, 42)}` as Hex;
  if (hex.length !== 50 || !hex.startsWith("41") || sha256(sha256(body)).slice(2, 10) !== hex.slice(42))
    throw new Error("Invalid Tron address checksum.");
  return hexAccount(`0x${hex.slice(2, 42)}`);
}

export function tonAccount(address: string): Hex {
  if (/^0:[0-9a-f]{64}$/i.test(address)) return hexAccount(`0x${address.slice(2)}`);
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(address)) throw new Error("Invalid TON address.");
  const bytes = Uint8Array.from(atob(address.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  let crc = 0;
  for (const byte of bytes.slice(0, 34)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  if (bytes.length !== 36 || ![0x11, 0x51].includes(bytes[0]) || bytes[1] !== 0 || crc !== (bytes[34] << 8 | bytes[35]))
    throw new Error("Direct OFT requires a valid TON mainnet basechain address.");
  return hexAccount(toHex(bytes.slice(2, 34)));
}

export function nonEvmRecipient(chainType: string, address: string): Hex {
  if (["APTOS", "SUI", "IOTAMOVE"].includes(chainType)) return hexAccount(address);
  if (chainType === "STARKNET") return hexAccount(address, 251);
  if (chainType === "TRON") return tronAccount(address);
  if (chainType === "TON") return tonAccount(address);
  if (chainType === "STELLAR") return address.startsWith("0x") ? hexAccount(address) : stellarAddressBytes32(address);
  throw new Error("Unsupported direct OFT recipient family.");
}

export function nonEvmTokenMatches(chainType: string, left: string, right: string): boolean {
  try {
    if (chainType === "TRON") return tronAccount(left) === tronAccount(right);
    if (chainType === "STARKNET" || (chainType === "APTOS" && !left.includes("::") && !right.includes("::"))) return hexAccount(left) === hexAccount(right);
    if (chainType === "TON") {
      const normalize = (value: string) => value.startsWith("0x") ? hexAccount(value) : tonAccount(value);
      return normalize(left) === normalize(right);
    }
    if (["APTOS", "SUI", "IOTAMOVE"].includes(chainType)) {
      const normalize = (value: string) => value.replace(/0x[0-9a-f]+(?=::)/gi, hex => hexAccount(hex));
      return normalize(left) === normalize(right);
    }
  } catch { return false; }
  return left === right;
}
