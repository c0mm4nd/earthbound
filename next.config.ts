import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@chainlink/ccip-sdk"],
  turbopack: {
    root: rootDir,
  },
};

export default nextConfig;
