import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import type { BridgeApiProvider, BridgeChain, BridgeChainType } from "@/lib/bridge-types";

const TRON_BASE58_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TRON_HEX_ADDRESS_PATTERN = /^41[a-fA-F0-9]{40}$/;
const HEX_ACCOUNT_PATTERN = /^0x[a-fA-F0-9]{1,64}$/;
const TON_RAW_ADDRESS_PATTERN = /^-?\d+:[a-fA-F0-9]{64}$/;
const TON_USER_FRIENDLY_ADDRESS_PATTERN = /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46,62}$/;

export function isEvmChainType(chainType?: BridgeChainType | null) {
  return chainType === "EVM";
}

export function isSolanaChainType(chainType?: BridgeChainType | null) {
  return chainType === "SOLANA";
}

export function requiresLayerZeroQuoteProvider(
  srcChain?: Pick<BridgeChain, "chainType"> | null,
  dstChain?: Pick<BridgeChain, "chainType"> | null,
) {
  return !isEvmChainType(srcChain?.chainType) || !isEvmChainType(dstChain?.chainType);
}

export function getDefaultBridgeApiProvider(
  srcChain?: Pick<BridgeChain, "chainType"> | null,
  dstChain?: Pick<BridgeChain, "chainType"> | null,
): BridgeApiProvider {
  void srcChain;
  void dstChain;
  return "stargate";
}

export function canExecuteSourceChainType(chainType?: BridgeChainType | null) {
  switch (chainType) {
    case "EVM":
    case "SOLANA":
    case "APTOS":
    case "TRON":
    case "STARKNET":
    case "TON":
    case "SUI":
    case "IOTAMOVE":
      return true;
    default:
      return false;
  }
}

export function getChainTypeDisplayLabel(chainType?: BridgeChainType | null) {
  switch (chainType) {
    case "EVM":
      return "EVM";
    case "SOLANA":
      return "Solana";
    case "APTOS":
      return "Aptos";
    case "TRON":
      return "Tron";
    case "STARKNET":
      return "Starknet";
    case "TON":
      return "TON";
    case "SUI":
      return "Sui";
    case "IOTAMOVE":
      return "IOTA Move";
    default:
      return chainType ?? "Unknown";
  }
}

export function getWalletConnectLabel(chainType?: BridgeChainType | null) {
  switch (chainType) {
    case "SOLANA":
      return "Connect Solana Wallet";
    case "APTOS":
      return "Connect Aptos Wallet";
    case "TRON":
      return "Connect Tron Wallet";
    case "STARKNET":
      return "Connect Starknet Wallet";
    case "TON":
      return "Connect TON Wallet";
    case "SUI":
      return "Connect Sui Wallet";
    case "IOTAMOVE":
      return "Connect IOTA Wallet";
    default:
      return "Connect Wallet";
  }
}

export function getDestinationAddressPlaceholder(chainType?: BridgeChainType | null) {
  switch (chainType) {
    case "SOLANA":
      return "Solana wallet address";
    case "APTOS":
      return "0x...";
    case "TRON":
      return "T...";
    case "STARKNET":
      return "0x...";
    case "TON":
      return "EQ...";
    case "SUI":
    case "IOTAMOVE":
      return "0x...";
    default:
      return "0x...";
  }
}

export function getAddressValidationCopy(chainType?: BridgeChainType | null) {
  switch (chainType) {
    case "SOLANA":
      return "Enter a valid Solana address.";
    case "APTOS":
      return "Enter a valid Aptos account address.";
    case "TRON":
      return "Enter a valid Tron address.";
    case "STARKNET":
      return "Enter a valid Starknet address.";
    case "TON":
      return "Enter a valid TON address.";
    case "SUI":
      return "Enter a valid Sui address.";
    case "IOTAMOVE":
      return "Enter a valid IOTA address.";
    default:
      return "Enter a valid EVM destination address.";
  }
}

export function validateAddressForChainType(
  chainType: BridgeChainType | undefined | null,
  address: string,
) {
  const normalizedAddress = address.trim();

  if (!normalizedAddress) {
    return false;
  }

  switch (chainType) {
    case "SOLANA":
      try {
        return new PublicKey(normalizedAddress).toBase58() === normalizedAddress;
      } catch {
        return false;
      }
    case "APTOS":
    case "STARKNET":
    case "SUI":
    case "IOTAMOVE":
      return HEX_ACCOUNT_PATTERN.test(normalizedAddress);
    case "TRON":
      return (
        TRON_BASE58_ADDRESS_PATTERN.test(normalizedAddress) ||
        TRON_HEX_ADDRESS_PATTERN.test(normalizedAddress)
      );
    case "TON":
      return (
        TON_RAW_ADDRESS_PATTERN.test(normalizedAddress) ||
        TON_USER_FRIENDLY_ADDRESS_PATTERN.test(normalizedAddress)
      );
    default:
      return isAddress(normalizedAddress);
  }
}
