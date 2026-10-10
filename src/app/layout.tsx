import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Providers } from "@/components/providers";
import { getAppOrigin } from "@/lib/app-origin";
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
  title: "Earthbound | Cross-chain Bridge",
  description:
    "Earthbound is an independently operated cross-chain bridge for transferring assets across networks.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const origin = getAppOrigin(requestHeaders);
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
