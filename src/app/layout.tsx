import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Earthbound Stargate Transfer",
  description:
    "A black-and-white Stargate-aligned transfer surface that reuses official chain and token data while lazy-loading balances only after token selection.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  const host = forwardedHost ?? requestHeaders.get("host");
  const protocol = forwardedProto ?? (process.env.NODE_ENV === "development" ? "http" : "https");
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL;
  const origin = host
    ? `${protocol}://${host}`
    : appUrl
      ? `${appUrl.startsWith("http://") || appUrl.startsWith("https://") ? "" : "https://"}${appUrl}`
      : "http://localhost:3000";
  const tonManifestUrl = `${origin}/tonconnect-manifest.json`;

  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers tonManifestUrl={tonManifestUrl}>{children}</Providers>
      </body>
    </html>
  );
}
