import { isCcipAddress } from "./ccip-addresses";
import { stellarAddressBytes32 } from "./stellar-address";
import { tonAccount } from "./direct-oft-address";
import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import type { BridgeApiProvider, BridgeChain, BridgeChainType } from "@/lib/bridge-types";

const TRON_BASE58_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TRON_HEX_ADDRESS_PATTERN = /^41[a-fA-F0-9]{40}$/;
const HEX_ACCOUNT_PATTERN = /^0x[a-fA-F0-9]{1,64}$/;

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
    case "CANTON": return "Canton";
    case "APTOS":
      return "Aptos";
    case "TRON":
      return "Tron";
    case "STARKNET":
      return "Starknet";
    case "TON":
      return "TON";
    case "STELLAR":
      return "Stellar";
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
    case "CANTON": return "Connect Canton Wallet";
    case "APTOS":
      return "Connect Aptos Wallet";
    case "TRON":
      return "Connect Tron Wallet";
    case "STARKNET":
      return "Connect Starknet Wallet";
    case "TON":
      return "Connect TON Wallet";
    case "STELLAR":
      return "Connect Stellar Wallet";
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
    case "CANTON": return "party::1220...";
    case "APTOS":
      return "0x...";
    case "TRON":
      return "T...";
    case "STARKNET":
      return "0x...";
    case "TON":
      return "EQ...";
    case "STELLAR":
      return "G... or deployed C...";
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
    case "CANTON": return "Enter a valid Canton party ID.";
    case "APTOS":
      return "Enter a valid Aptos account address.";
    case "TRON":
      return "Enter a valid Tron address.";
    case "STARKNET":
      return "Enter a valid Starknet address.";
    case "TON":
      return "Enter a valid TON mainnet basechain address.";
    case "STELLAR":
      return "Enter a valid Stellar G account or deployed C contract address.";
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
    case "CANTON": return isCcipAddress("CANTON", normalizedAddress);
    case "STELLAR":
      try { stellarAddressBytes32(normalizedAddress); return true; } catch { return false; }
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
      try { tonAccount(normalizedAddress); return true; } catch { return false; }
    default:
      return isAddress(normalizedAddress);
  }
}
