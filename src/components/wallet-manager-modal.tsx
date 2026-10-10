"use client";

import { useEffect, useRef, useState } from "react";
import { WALLET_NETWORKS, type WalletNetwork, type WalletOption, type WalletSession } from "@/lib/wallet-options";

export function WalletManagerModal({ initialNetwork, sessions, getOptions, onConnect, onDisconnect, onClose }: {
  initialNetwork: WalletNetwork;
  sessions: Partial<Record<WalletNetwork, WalletSession>>;
  getOptions: (network: WalletNetwork) => WalletOption[];
  onConnect: (network: WalletNetwork, walletId: string) => Promise<void>;
  onDisconnect: (network: WalletNetwork) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [network, setNetwork] = useState(initialNetwork);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const session = sessions[network];
  const wallets = getOptions(network);
  const networkLabel = WALLET_NETWORKS.find((item) => item.type === network)!.label;

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  async function run(action: string, task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(action);
    setError(null);
    setCopied(false);
    try { await task(); } catch (error) {
      setError(error instanceof Error ? error.message : "Wallet operation failed.");
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  }

  return (
    <dialog ref={dialogRef} aria-labelledby="wallet-manager-title" onClose={onClose}
      onCancel={(event) => { if (pending) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-[1.6rem] border border-white/12 bg-[var(--overlay-surface)] p-5 text-white shadow-2xl backdrop:bg-black/80">
      <div className="flex items-center justify-between gap-3">
        <h2 id="wallet-manager-title" className="text-lg font-medium">Wallets</h2>
        <button type="button" disabled={pending !== null} onClick={onClose} className="rounded-full border border-white/12 h-9 px-3 text-xs disabled:opacity-45">Close</button>
      </div>
      <div aria-label="Wallet networks" className="mt-4 flex flex-wrap gap-2">
        {WALLET_NETWORKS.map((item) => (
          <button key={item.type} type="button" aria-pressed={network === item.type} disabled={pending !== null}
            onClick={() => { setNetwork(item.type); setError(null); setCopied(false); }}
            className={`rounded-full border h-9 px-3 text-xs disabled:opacity-45 ${network === item.type ? "border-white bg-white text-black" : "border-white/12 text-white/70"}`}>
            {item.label}{sessions[item.type] ? <span aria-label="connected"> · ✓</span> : null}
          </button>
        ))}
      </div>
      {session ? (
        <div className="mt-4 rounded-xl border border-white/12 bg-white/[0.04] p-4">
          <p className="text-sm font-medium">{session.label} <span className="text-xs text-white/50">Connected</span></p>
          <p className="mt-2 break-all font-mono text-xs text-white/70">{session.address}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={pending !== null} onClick={() => void run("copy", async () => { await navigator.clipboard.writeText(session.address); setCopied(true); })}
              className="rounded-full border border-white/12 h-9 px-3 text-xs disabled:opacity-45">{copied ? "Copied" : "Copy address"}</button>
            <button type="button" disabled={pending !== null} onClick={() => void run("disconnect", () => onDisconnect(network))}
              className="rounded-full border border-white/12 h-9 px-3 text-xs disabled:opacity-45">{pending === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>
          </div>
        </div>
      ) : null}
      <p className="mt-5 text-sm text-white/60">{session ? `Switch ${networkLabel} wallet` : `Connect ${networkLabel} wallet`}</p>
      <div className="mt-3 space-y-2">
        {wallets.map((wallet) => (
          <button key={wallet.id} type="button" disabled={!wallet.installed || pending !== null || session?.walletId === wallet.id}
            onClick={() => void run(wallet.id, () => onConnect(network, wallet.id))}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2.5 text-xs transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45">
            <span className="font-medium">{wallet.label}</span>
            <span className="text-xs text-white/50">{pending === wallet.id ? "Connecting…" : session?.walletId === wallet.id ? "Connected" : wallet.installed ? (network === "TON" ? "Choose wallet" : "Detected") : "Not detected"}</span>
          </button>
        ))}
      </div>
      {!wallets.some((wallet) => wallet.installed) ? <p className="mt-3 text-sm text-white/60">No compatible {networkLabel} wallet detected. Install or enable a wallet, then refresh this page.</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error}</p> : null}
    </dialog>
  );
}
