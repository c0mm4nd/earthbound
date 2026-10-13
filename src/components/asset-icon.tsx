"use client";

import { useState } from "react";
import { getAssetIconFallback, PROTOCOL_ICONS, safeIconUrl } from "@/lib/bridge-icons";

type IconSize = "xs" | "sm" | "md";
function IconImage({ src, fallbackSrc, initials }: { src?: string; fallbackSrc?: string; initials: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const active = [safeIconUrl(src), safeIconUrl(fallbackSrc)].find(url => url && !failed.includes(url));
  if (!active) return <>{initials}</>;
  return (
    // SVG and metadata assets render directly without an image-proxy roundtrip.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={active} alt="" className="h-full w-full rounded-full object-contain" loading="lazy" decoding="async"
      onError={() => setFailed(current => [...current, active])} />
  );
}
function AssetIconBadge({ label, src, size }: { label: string; src?: string; size: IconSize }) {
  const initials = label.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
  const sizeClass = size === "xs" ? "h-3.5 w-3.5 text-[6px]" : size === "sm" ? "h-[1.125rem] w-[1.125rem] text-[7px]" : "h-5 w-5 text-[8px]";
  return <span className={`inline-flex ${sizeClass} items-center justify-center overflow-hidden rounded-full border border-[var(--panel)] bg-black font-semibold uppercase tracking-[0.12em] text-white`} aria-hidden="true">
    <IconImage key={src ?? label} src={src} initials={initials} />
  </span>;
}
export function AssetIcon({ label, src, badgeLabel, badgeSrc, size = "md" }: {
  label: string; src?: string; badgeLabel?: string; badgeSrc?: string; size?: IconSize;
}) {
  const initials = label.replace(/[^a-z0-9]/gi, "").slice(0, size === "md" ? 3 : 2) || "?";
  const sizeClass = size === "xs" ? "h-4 w-4 text-[7px]" : size === "sm" ? "h-9 w-9 text-[9px]" : "h-11 w-11 text-[11px]";
  return <span className={`relative inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.06] font-semibold uppercase tracking-[0.18em] text-white`} aria-hidden="true">
    <IconImage key={`${src ?? ""}:${label}`} src={src} fallbackSrc={getAssetIconFallback(src, label)} initials={initials} />
    {badgeLabel ? <span className="pointer-events-none absolute -right-0.5 -bottom-0.5">
      <AssetIconBadge label={badgeLabel} src={badgeSrc} size={size} />
    </span> : null}
  </span>;
}
export function ProtocolIcon({ provider }: { provider?: string }) {
  if (provider !== "ccip" && provider !== "cctp") return null;
  return <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white p-0.5" aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={PROTOCOL_ICONS[provider]} alt="" width={16} height={16} className="h-4 w-4 object-contain" />
  </span>;
}
