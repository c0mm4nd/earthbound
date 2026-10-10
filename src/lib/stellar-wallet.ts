import { stellarAddressBytes32 } from "./stellar-address";

export const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export async function connectStellarWallet(walletId?: string) {
  if (walletId !== "freighter") throw new Error("Select the Freighter wallet to connect.");
  const wallet = await import("@stellar/freighter-api");
  const connected = await wallet.isConnected();
  if (!connected.isConnected) throw new Error("Freighter is not detected. Install or enable Freighter, then refresh.");
  const result = await wallet.requestAccess();
  if (result.error || !result.address) throw new Error(result.error?.message ?? "Freighter connection was not approved.");
  const network = await wallet.getNetworkDetails();
  if (network.error || network.networkPassphrase !== STELLAR_MAINNET_PASSPHRASE) throw new Error("Select Stellar mainnet in Freighter before connecting.");
  stellarAddressBytes32(result.address, "account");
  return { address: result.address, label: "Freighter", walletId: "freighter" };
}

export function watchStellarWallet(onAddress: (address: string | null) => void) {
  let cancelled = false;
  let stop: (() => void) | undefined;
  void import("@stellar/freighter-api").then(({ WatchWalletChanges }) => {
    if (cancelled) return;
    const watcher = new WatchWalletChanges();
    watcher.watch(({ address, networkPassphrase, error }) => {
      if (cancelled) return;
      if (error || networkPassphrase !== STELLAR_MAINNET_PASSPHRASE) { onAddress(null); return; }
      try { stellarAddressBytes32(address, "account"); onAddress(address); } catch { onAddress(null); }
    });
    stop = () => watcher.stop();
  }).catch(() => { if (!cancelled) onAddress(null); });
  return () => { cancelled = true; stop?.(); };
}
