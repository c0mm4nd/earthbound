"use client";

import { useState, useMemo, type FormEvent } from "react";
import { useRpcConfig } from "@/components/providers";
import {
  DEFAULT_RPC_URLS,
  getEffectiveRpcUrls,
  type RpcConfig,
} from "@/lib/rpc-config";
import { walletChainByKey } from "@/lib/wagmi";

const FIELD_CLASS =
  "w-full rounded-[1.25rem] border border-white/10 bg-black px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/28 font-mono";
const GHOST_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white transition hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BUTTON_CLASS =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/76 transition hover:border-white/24 hover:bg-white/[0.08] hover:text-white";

const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  base: "Base",
  optimism: "Optimism",
  bsc: "BNB Chain",
  avalanche: "Avalanche",
  polygon: "Polygon",
  linea: "Linea",
  abstract: "Abstract",
  hemi: "Hemi",
  hyperliquid: "Hyperliquid",
  manta: "Manta Pacific",
  metis: "Metis",
  plasma: "Plasma",
  scroll: "Scroll",
  somnia: "Somnia",
  soneium: "Soneium",
  unichain: "Unichain",
  worldchain: "World Chain",
  zircuit: "Zircuit",
};

const NON_EVM_CHAIN_KEYS = ["solana", "sui", "iota"] as const;
const NON_EVM_CHAIN_DISPLAY_NAMES: Record<string, string> = {
  solana: "Solana",
  sui: "SUI",
  iota: "IOTA",
};

// Reverse map: chainId → chainKey (for walletChainByKey entries)
const chainKeyByWalletId: Record<number, string> = Object.fromEntries(
  Object.entries(walletChainByKey).map(([key, chain]) => [chain.id, key]),
);

export function RpcSettingsModal({ onClose }: { onClose: () => void }) {
  const { rpcConfig, updateRpcConfig, evmChains } = useRpcConfig();

  // Derive a stable key for each EVM chain: use walletChainByKey key if known, else chain.id.toString()
  const evmChainEntries = useMemo(
    () =>
      evmChains.map((chain) => ({
        chain,
        key: chainKeyByWalletId[chain.id] ?? chain.id.toString(),
        displayName:
          CHAIN_DISPLAY_NAMES[chainKeyByWalletId[chain.id] ?? ""] ?? chain.name,
      })),
    [evmChains],
  );

  const allKeys = useMemo(
    () => [...evmChainEntries.map((e) => e.key), ...NON_EVM_CHAIN_KEYS],
    [evmChainEntries],
  );

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const key of allKeys) {
      const saved = rpcConfig[key];
      init[key] = saved && saved.length > 0 ? saved.join("\n") : "";
    }
    return init;
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: RpcConfig = {};
    for (const key of allKeys) {
      const urls = drafts[key]
        ?.split("\n")
        .map((u) => u.trim())
        .filter(Boolean);
      if (urls && urls.length > 0) {
        next[key] = urls;
      }
    }
    updateRpcConfig(next);
    onClose();
  }

  function handleReset() {
    const cleared: Record<string, string> = {};
    for (const key of allKeys) {
      cleared[key] = "";
    }
    setDrafts(cleared);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/78 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-[1.6rem] border border-white/12 bg-[var(--panel)] shadow-[0_32px_90px_rgba(0,0,0,0.55)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 pb-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              EVM · Solana · SUI · IOTA
            </p>
            <h2 className="mt-2 text-lg font-medium tracking-[-0.03em] text-white">
              RPC Configuration
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              One URL per line. EVM chains use all URLs as fallbacks; non-EVM chains use only the first.
              Leave blank to use built-in public defaults. Changes take effect immediately.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={ICON_BUTTON_CLASS}
            aria-label="Close RPC configuration dialog"
          >
            <XIcon />
          </button>
        </div>

        {/* Scrollable chain list */}
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
            <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.24em] text-white/30">
              EVM · Multiple fallbacks
            </p>
            <div className="space-y-4">
              {evmChainEntries.map(({ chain, key, displayName }) => {
                const defaults = DEFAULT_RPC_URLS[key] ?? [];
                const effective = getEffectiveRpcUrls(key, rpcConfig);
                const isCustomized =
                  rpcConfig[key] && rpcConfig[key]!.length > 0;
                return (
                  <label key={chain.id} className="block space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                        {displayName}
                      </span>
                      {isCustomized ? (
                        <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-white/50">
                          Custom
                        </span>
                      ) : defaults.length > 0 ? (
                        <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-white/30">
                          {effective.length} fallback{effective.length !== 1 ? "s" : ""}
                        </span>
                      ) : null}
                    </div>
                    <textarea
                      rows={2}
                      value={drafts[key] ?? ""}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={
                        defaults.length > 0
                          ? defaults.join("\n")
                          : "Uses chain default RPC"
                      }
                      className={`${FIELD_CLASS} resize-none`}
                      spellCheck={false}
                    />
                  </label>
                );
              })}
            </div>

            <p className="mb-3 mt-6 text-[9px] font-semibold uppercase tracking-[0.24em] text-white/30">
              Non-EVM · First URL used
            </p>
            <div className="space-y-4">
              {NON_EVM_CHAIN_KEYS.map((chainKey) => {
                const defaults = DEFAULT_RPC_URLS[chainKey] ?? [];
                const isCustomized =
                  rpcConfig[chainKey] && rpcConfig[chainKey]!.length > 0;
                return (
                  <label key={chainKey} className="block space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                        {NON_EVM_CHAIN_DISPLAY_NAMES[chainKey] ?? chainKey}
                      </span>
                      {isCustomized ? (
                        <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-white/50">
                          Custom
                        </span>
                      ) : null}
                    </div>
                    <textarea
                      rows={2}
                      value={drafts[chainKey] ?? ""}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [chainKey]: e.target.value }))
                      }
                      placeholder={defaults.join("\n") || "Uses chain default RPC"}
                      className={`${FIELD_CLASS} resize-none`}
                      spellCheck={false}
                    />
                  </label>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-white/8 p-5 pt-4">
            <button
              type="button"
              onClick={handleReset}
              className="text-xs text-[var(--muted)] underline underline-offset-2 transition hover:text-white"
            >
              Reset all to defaults
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className={GHOST_BUTTON_CLASS}>
                Cancel
              </button>
              <button type="submit" className={PRIMARY_BUTTON_CLASS}>
                Apply
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function XIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
    </svg>
  );
}
