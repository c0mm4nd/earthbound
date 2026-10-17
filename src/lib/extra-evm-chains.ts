import { defineChain } from "viem";

// Mainnets missing from the installed viem/chains version. Chain IDs and RPCs
// checked against official bridge metadata and linked network docs on 2026-10-13.
// https://metadata.layerzero-api.com/v1/metadata
// Use the bridge catalog's native (gas) decimals: Arc's ERC20 USDC has 6,
// but native balances and msg.value use 18.
export const extraEvmChains = {
  // https://docs.ab.org/zh/docs/
  ab: defineChain({
    id: 36888,
    name: "AB Core",
    nativeCurrency: { name: "AB", symbol: "AB", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc1.core.ab.org", "https://rpc.core.ab.org"] } },
    blockExplorers: { default: { name: "AB Explorer", url: "https://explorer.core.ab.org" } },
  }),
  apexfusionnexus: defineChain({
    id: 9069,
    name: "Apex Fusion Nexus",
    nativeCurrency: { name: "AP3X", symbol: "AP3X", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.nexus.mainnet.apexfusion.org"] } },
    blockExplorers: { default: { name: "Apex Fusion Nexus Explorer", url: "https://nexus.apexscan.org" } },
  }),
  arc: defineChain({
    id: 5042,
    name: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
    blockExplorers: { default: { name: "Arc Explorer", url: "https://arc.etherscan.io" } },
  }),
  // https://docs.aultblockchain.com/network-information/mainnet
  ault: defineChain({
    id: 904,
    name: "Ault",
    nativeCurrency: { name: "AULT", symbol: "AULT", decimals: 18 },
    rpcUrls: { default: { http: ["https://main-json-rpc.cloud.aultblockchain.xyz"] } },
    blockExplorers: { default: { name: "Ault Explorer", url: "https://ault.explorer.orynt.tech" } },
  }),
  // Catalog endpoint currently unreachable; a custom RPC can be set in Settings.
  camp: defineChain({
    id: 484,
    name: "Camp",
    nativeCurrency: { name: "CAMP", symbol: "CAMP", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.camp.raas.gelato.cloud"] } },
    blockExplorers: { default: { name: "Camp Explorer", url: "https://camp.cloud.blockscout.com" } },
  }),
  doma: defineChain({
    id: 97477,
    name: "Doma",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://doma.drpc.org", "https://rpc.doma.xyz"] } },
    blockExplorers: { default: { name: "Doma Explorer", url: "https://explorer.doma.xyz" } },
  }),
  ethereal: defineChain({
    id: 5064014,
    name: "Ethereal",
    nativeCurrency: { name: "USDe", symbol: "USDe", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.ethereal.trade"] } },
    blockExplorers: { default: { name: "Ethereal Explorer", url: "https://explorer.ethereal.trade" } },
  }),
  // https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-3343.json
  edge: defineChain({
    id: 3343,
    name: "Edge",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://edge-mainnet.g.alchemy.com/public"] } },
  }),
  gatelayer: defineChain({
    id: 10088,
    name: "Gate Layer",
    nativeCurrency: { name: "GT", symbol: "GT", decimals: 18 },
    rpcUrls: { default: { http: ["https://gatelayer-mainnet.gatenode.cc"] } },
    blockExplorers: { default: { name: "Gate Layer Explorer", url: "https://www.gatescan.org/gatelayer" } },
  }),
  // https://github.com/gensyn-network/gensyn-buyback/blob/master/docs/SETUP.md
  gensyn: defineChain({
    id: 685689,
    name: "Gensyn",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://gensyn-mainnet.g.alchemy.com/public"] } },
    blockExplorers: { default: { name: "Gensyn Explorer", url: "https://gensyn-mainnet.explorer.alchemy.com/" } },
  }),
  // Catalog endpoint currently unreachable; a custom RPC can be set in Settings.
  glue: defineChain({
    id: 1300,
    name: "Glue",
    nativeCurrency: { name: "GLUE", symbol: "GLUE", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet-node.m9.glue.net"] } },
    blockExplorers: { default: { name: "Glue Explorer", url: "https://explorer.glue.net" } },
  }),
  // L1 is distinct from Gravity Alpha (1625); do not replace its ID or OFT EID.
  // https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-127001.json
  gravityL1: defineChain({
    id: 127001,
    name: "Gravity L1",
    nativeCurrency: { name: "Gravity", symbol: "G", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet-rpc.gravity.xyz"] } },
  }),
  // https://docs.horizen.io/horizen-chain/network/mainnet/
  horizen: defineChain({
    id: 26514,
    name: "Horizen",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://horizen.calderachain.xyz/http"] } },
    blockExplorers: { default: { name: "Horizen Explorer", url: "https://explorer.horizen.io" } },
  }),
  kite: defineChain({
    id: 2366,
    name: "Kite",
    nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.gokite.ai"] } },
    blockExplorers: { default: { name: "Kite Explorer", url: "https://kitescan.ai" } },
  }),
  moca: defineChain({
    id: 2288,
    name: "Moca",
    nativeCurrency: { name: "MOCA", symbol: "MOCA", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mocachain.org"] } },
    blockExplorers: { default: { name: "Moca Explorer", url: "https://scan.mocachain.org" } },
  }),
  // https://app.transporter.io — publicRpcUrl for mova-mainnet-2 (61901).
  // rpc.movachain.com and third-party aliases can return the old 61900 network.
  mova: defineChain({
    id: 61901,
    name: "Mova",
    nativeCurrency: { name: "MOVA", symbol: "MOVA", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.movan.movachain.com"] } },
    blockExplorers: { default: { name: "Mova Explorer", url: "https://scan.movan.movachain.com" } },
  }),
  opn: defineChain({
    id: 222,
    name: "OPN",
    nativeCurrency: { name: "IOPN", symbol: "IOPN", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet-rpc.iopn.tech", "https://mainnet-rpc2.iopn.tech"] } },
    blockExplorers: { default: { name: "OPN Explorer", url: "https://opnscan.io" } },
  }),
  pharos: defineChain({
    id: 1672,
    name: "Pharos",
    nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.pharos.xyz"] } },
  }),
  // https://docs.rayls.com/docs/public-chain-reference
  rayls: defineChain({
    id: 72957,
    name: "Rayls",
    nativeCurrency: { name: "USDr", symbol: "USDr", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet-rpc.rayls.com"] } },
    blockExplorers: { default: { name: "Rayls Explorer", url: "https://explorer.rayls.com" } },
  }),
  // https://docs.robinhood.com/chain/connecting/
  robinhood: defineChain({
    id: 4663,
    name: "Robinhood",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Robinhood Explorer", url: "https://robinhoodchain.blockscout.com" } },
    sourceId: 1,
  }),
  zkverify: defineChain({
    id: 1408,
    name: "zkVerify",
    nativeCurrency: { name: "VFY", symbol: "VFY", decimals: 18 },
    rpcUrls: { default: { http: ["https://vflow-rpc.zkverify.io"] } },
    blockExplorers: { default: { name: "zkVerify Explorer", url: "https://vflow.subscan.io" } },
  }),
} as const;

export const robinhood = extraEvmChains.robinhood;
