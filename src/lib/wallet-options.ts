export const WALLET_NETWORKS = [
  { type: "EVM", label: "EVM" },
  { type: "SOLANA", label: "Solana" },
  { type: "SUI", label: "Sui" },
  { type: "IOTAMOVE", label: "IOTA" },
  { type: "APTOS", label: "Aptos" },
  { type: "TRON", label: "Tron" },
  { type: "STARKNET", label: "Starknet" },
  { type: "TON", label: "TON" },
  { type: "STELLAR", label: "Stellar" },
] as const;

export type WalletNetwork = (typeof WALLET_NETWORKS)[number]["type"];
export type WalletOption = { id: string; label: string; installed: boolean };
export type WalletSession = { address: string; label: string; walletId?: string };

export function walletIdentifier(wallet: { id?: string; name: string }): string {
  return wallet.id ?? wallet.name;
}
