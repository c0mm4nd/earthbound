// Mainnet USDC facts checked against Circle on 2026-10-12.
// https://developers.circle.com/cctp/concepts/supported-chains-and-domains
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// Domain IDs are NOT EVM chain IDs. This catalog does not enable execution.
export type CctpFamily = "EVM" | "SOLANA" | "APTOS" | "SUI" | "STARKNET" | "STELLAR";
export interface CctpNetwork {
  domain: number;
  name: string;
  family: CctpFamily;
  usdc: string;
  decimals: number;
  fastSource: boolean;
  upfrontFees: boolean;
  circleForwarding: boolean;
}
export const CCTP_NETWORKS: readonly CctpNetwork[] = [
  {
    "domain": 0,
    "name": "Ethereum",
    "family": "EVM",
    "usdc": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 1,
    "name": "Avalanche",
    "family": "EVM",
    "usdc": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 2,
    "name": "OP Mainnet",
    "family": "EVM",
    "usdc": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 3,
    "name": "Arbitrum",
    "family": "EVM",
    "usdc": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 5,
    "name": "Solana",
    "family": "SOLANA",
    "usdc": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": false,
    "circleForwarding": true
  },
  {
    "domain": 6,
    "name": "Base",
    "family": "EVM",
    "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 7,
    "name": "Polygon PoS",
    "family": "EVM",
    "usdc": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 8,
    "name": "Sui",
    "family": "SUI",
    "usdc": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 9,
    "name": "Aptos",
    "family": "APTOS",
    "usdc": "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 10,
    "name": "Unichain",
    "family": "EVM",
    "usdc": "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 11,
    "name": "Linea",
    "family": "EVM",
    "usdc": "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 12,
    "name": "Codex",
    "family": "EVM",
    "usdc": "0xd996633a415985DBd7D6D12f4A4343E31f5037cf",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 13,
    "name": "Sonic",
    "family": "EVM",
    "usdc": "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 14,
    "name": "World Chain",
    "family": "EVM",
    "usdc": "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 15,
    "name": "Monad",
    "family": "EVM",
    "usdc": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 16,
    "name": "Sei",
    "family": "EVM",
    "usdc": "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 18,
    "name": "XDC",
    "family": "EVM",
    "usdc": "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 19,
    "name": "HyperEVM",
    "family": "EVM",
    "usdc": "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 21,
    "name": "Ink",
    "family": "EVM",
    "usdc": "0x2D270e6886d130D724215A266106e6832161EAEd",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 22,
    "name": "Plume",
    "family": "EVM",
    "usdc": "0x222365EF19F7947e5484218551B56bb3965Aa7aF",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 25,
    "name": "Starknet",
    "family": "STARKNET",
    "usdc": "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 26,
    "name": "Arc",
    "family": "EVM",
    "usdc": "0x3600000000000000000000000000000000000000",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": true,
    "circleForwarding": true
  },
  {
    "domain": 27,
    "name": "Stellar",
    "family": "STELLAR",
    "usdc": "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "decimals": 7,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 28,
    "name": "EDGE",
    "family": "EVM",
    "usdc": "0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": false,
    "circleForwarding": true
  },
  {
    "domain": 29,
    "name": "Injective",
    "family": "EVM",
    "usdc": "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 30,
    "name": "Morph",
    "family": "EVM",
    "usdc": "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 31,
    "name": "Pharos",
    "family": "EVM",
    "usdc": "0xC879C018dB60520F4355C26eD1a6D572cdAC1815",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 32,
    "name": "Cronos",
    "family": "EVM",
    "usdc": "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 33,
    "name": "Plasma",
    "family": "EVM",
    "usdc": "0x2d661C89D812261039AF9764eceaAee884f5F67F",
    "decimals": 6,
    "fastSource": false,
    "upfrontFees": false,
    "circleForwarding": false
  },
  {
    "domain": 37,
    "name": "X Layer",
    "family": "EVM",
    "usdc": "0xB6CEceAB302E2E4948951eE7843FC24E92933061",
    "decimals": 6,
    "fastSource": true,
    "upfrontFees": false,
    "circleForwarding": false
  }
];
