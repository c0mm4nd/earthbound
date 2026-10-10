"use client";

import type { ReactNode } from "react";

export function ToggleSwitch({
  checked,
  onCheckedChange,
  disabled = false,
  children,
  className = "",
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`group inline-flex min-h-9 min-w-0 items-center gap-2 rounded-lg text-left text-xs leading-5 text-[var(--muted)] transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/80 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors motion-reduce:transition-none ${
          checked ? "border-white bg-white" : "border-white/25 bg-white/10 group-hover:border-white/40"
        }`}
      >
        <span
          className={`absolute left-px h-3 w-3 rounded-full transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-3 bg-black" : "translate-x-0 bg-white/70"
          }`}
        />
      </span>
      <span>{children}</span>
    </button>
  );
}
