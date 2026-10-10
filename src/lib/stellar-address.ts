import { hexToBytes, toHex, type Hex } from "viem";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function checksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
// StrKey G (Ed25519 account) and C (Soroban contract) only. Muxed addresses
// contain an extra ID that cannot be represented by OFT's bytes32 recipient.
export function stellarAddressBytes32(address: string, kind?: "account" | "contract"): Hex {
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) throw new Error("Enter a Stellar G account or deployed C contract address; muxed addresses are not supported.");
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const char of address) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
    buffer &= (1 << bits) - 1;
  }
  const decoded = Uint8Array.from(bytes);
  if (decoded.length !== 35 || ![16, 48].includes(decoded[0]) ||
    (kind === "account" && decoded[0] !== 48) || (kind === "contract" && decoded[0] !== 16) ||
    checksum(decoded.slice(0, 33)) !== (decoded[33] | decoded[34] << 8)) throw new Error("Invalid Stellar address checksum or type.");
  const payload = toHex(decoded.slice(1, 33));
  if (BigInt(payload) === BigInt(0)) throw new Error("The zero Stellar address cannot receive a direct OFT transfer.");
  return payload;
}

export function stellarContractAddress(payload: Hex): string {
  if (!/^0x[0-9a-f]{64}$/i.test(payload)) throw new Error("Invalid Stellar contract payload.");
  const bytes = new Uint8Array(35);
  bytes[0] = 16;
  bytes.set(hexToBytes(payload), 1);
  const crc = checksum(bytes.slice(0, 33));
  bytes[33] = crc & 255; bytes[34] = crc >> 8;
  let buffer = 0, bits = 0, encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; encoded += ALPHABET[(buffer >> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  return encoded;
}
