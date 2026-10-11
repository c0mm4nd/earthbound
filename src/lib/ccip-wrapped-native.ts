import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { CcipCatalog, CcipChain } from "./ccip";
import { isCcipNative } from "./ccip-native";

export const WRAPPED_NATIVE_ABI = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);
export const WRAPPED_NATIVE_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
// Exact locally native wrappers, not token-symbol matching. Checked 2026-10-12.
// 0G uses its native WrappedOGBase precompile behind this ERC20 wrapper.
export const CCIP_WRAPPED_NATIVE: Record<number, {
  selector: string; router: Address; symbol: string; rpc: string; token: Address; codeHash: Hex; implementation: Hex; implementationHash?: Hex;
  vault?: { address: Address; codeHash: Hex };
}> = {
  "1": {
    "selector": "5009297550715157269",
    "router": "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
    "symbol": "ETH",
    "rpc": "https://ethereum-rpc.publicnode.com",
    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "codeHash": "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "10": {
    "selector": "3734403246176062136",
    "router": "0x3206695cae29952f4b0c22a169725a865bc8ce0f",
    "symbol": "ETH",
    "rpc": "https://mainnet.optimism.io",
    "token": "0x4200000000000000000000000000000000000006",
    "codeHash": "0x779bbf2a738ef09d961c945116197e2ac764c1b39304b2b4418cd4e42668b173",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "8453": {
    "selector": "15971525489660198786",
    "router": "0x881e3a65b4d4a04dd529061dd0071cf975f58bcd",
    "symbol": "ETH",
    "rpc": "https://mainnet.base.org",
    "token": "0x4200000000000000000000000000000000000006",
    "codeHash": "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "42161": {
    "selector": "4949039107694359620",
    "router": "0x141fa059441e0ca23ce184b6a78bafd2a517dde8",
    "symbol": "ETH",
    "rpc": "https://arb1.arbitrum.io/rpc",
    "token": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    "codeHash": "0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7",
    "implementation": "0x0000000000000000000000008b194beae1d3e0788a1a35173978001acdfba668",
    "implementationHash": "0x0d1c20f9ed551efe8f402bc9aa1a9b5058f925ec615284c5b4a7a4623c3b2dcd"
  },
  "16661": {
    "selector": "4426351306075016396",
    "router": "0x0aa145a62153190b8f0d3ca00c441e451529f755",
    "symbol": "0G",
    "rpc": "https://evmrpc.0g.ai",
    "token": "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c",
    "codeHash": "0xd50c534c414acaf55b4f45dcbddcf8f9118907d64d375f7bc2a145dd80cec607",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "592": {
    "selector": "6422105447186081193",
    "router": "0x8d5c5cb8ec58285b424c93436189fb865e437fef",
    "symbol": "ASTR",
    "rpc": "https://evm.astar.network",
    "token": "0x37795FdD8C165CaB4D6c05771D564d80439CD093",
    "codeHash": "0xe43bee32e72015dcf7bba78d89eed5e6d307c9a461f3deb860629c81346fb74d",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "177": {
    "selector": "7613811247471741961",
    "router": "0xf2fd62c083f3bf324e99ce157d1a42d7eba77f1d",
    "symbol": "HSK",
    "rpc": "https://mainnet.hsk.xyz",
    "token": "0xb210d2120d57b758ee163cffb43e73728c471cf1",
    "codeHash": "0x968d189152325d9e84cbda0dcd6140f0bc8f182dd67e9c226a1089089a6ecdc5",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "2020": {
    "selector": "6916147374840168594",
    "router": "0x46527571d5d1b68ee7eb60b18a32e6c60dceaf99",
    "symbol": "RON",
    "rpc": "https://api.roninchain.com/rpc",
    "token": "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
    "codeHash": "0x1edd9f7e58c5f46f2dde0cc323059a86fa0ad6c604fd6b93740ea31909e13d5c",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "59144": {
    "selector": "4627098889531055414",
    "router": "0x549feb73f2348f6cd99b9fc8c69252034897f06c",
    "symbol": "ETH",
    "rpc": "https://rpc.linea.build",
    "token": "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
    "codeHash": "0xa670ec6c272ddec6d328d6f3d5cad65a841a6ab45e8e5cf825150eb458be4f1f",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "964": {
    "selector": "2135107236357186872",
    "router": "0xd941fbecd2b971d0f54b4c34286c95fab52b60b8",
    "symbol": "TAO",
    "rpc": "https://lite.chain.opentensor.ai",
    "token": "0xC5b6C1632d34901239396F5E1BDe54B342900256",
    "codeHash": "0x6767a3819c376a30595efd8b0c2fdb3cfa29e39fcecabcb1417181763f50cb92",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "vault": { "address": "0x11837459896D96F821a8D88eC93a3C8D152033D4", "codeHash": "0x5dc19f73ca223562b39e63b6d00a12968f651a1d50c16b94c675f1d28fde65c8" }
  },
  "1672": {
    "symbol": "PROS",
    "rpc": "https://rpc.pharos.xyz",
    "token": "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0",
    "codeHash": "0x0896e7a43b7eddb23349f2e874fd51b547e22ad97ae931d7aca16d6990690677",
    "implementation": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "selector": "7801139999541420232",
    "router": "0x4e52dd94e9bcfefe3c78153bdfb0ab1d30687297"
  }
};

export function wrappedNativeForChain(chain: Pick<CcipChain, "chainType" | "chainId" | "nativeCurrency" | "ccip">) {
  const config = chain.chainType === "EVM" ? CCIP_WRAPPED_NATIVE[chain.chainId] : undefined;
  return config && config.selector === chain.ccip.selector && config.router.toLowerCase() === chain.ccip.router.toLowerCase() && chain.nativeCurrency.decimals === 18 && chain.nativeCurrency.symbol.toUpperCase() === config.symbol.toUpperCase() ? config : undefined;
}

export function addWrappedNativeRoutes(catalog: CcipCatalog): CcipCatalog {
  const entries = catalog.chains.flatMap(chain => {
    const config = wrappedNativeForChain(chain);
    const token = config && catalog.tokens.find(t => t.chainKey === chain.chainKey && t.address.toLowerCase() === config.token.toLowerCase() && t.decimals === 18);
    return config && token ? [{ chain, config, token }] : [];
  });
  // Keep the wrapped deployment as an option. Native aliases inherit only its
  // exact directed lanes, including non-EVM destinations with different decimals.
  const tokens = catalog.tokens.filter(t => !entries.some(e => e.chain.chainKey === t.chainKey && isCcipNative(t.address))).map(token => ({
    ...token, ccip: token.ccip ? { destinations: token.ccip.destinations.flatMap(dest => {
      const entry = entries.find(e => e.chain.chainKey === dest.chainKey && e.config.token.toLowerCase() === dest.address.toLowerCase());
      return entry ? [dest, { chainKey: dest.chainKey, address: entry.chain.nativeCurrency.address }] : [dest];
    }) } : undefined,
  }));
  for (const { chain, token } of entries) tokens.push({ ...chain.nativeCurrency, chainKey: chain.chainKey,
    isSupported: true, isBridgeable: true, bridgeProviders: ["ccip"],
    ccip: tokens.find(t => t.chainKey === token.chainKey && t.address === token.address)!.ccip,
  });
  return { ...catalog, tokens };
}

export function nativeConversionTransaction(chainId: number, token: string, amount: string, operation: "wrap" | "unwrap") {
  const config = CCIP_WRAPPED_NATIVE[chainId];
  if (!config || config.token.toLowerCase() !== token.toLowerCase() || !/^\d{1,78}$/.test(amount) || BigInt(amount) <= BigInt(0) || BigInt(amount) >= BigInt(2) ** BigInt(256)) throw new Error("Unsupported native conversion.");
  assertNativeConversionAmount(chainId, amount, operation);
  if (config.vault) return { to: config.vault.address, value: operation === "wrap" ? BigInt(amount) : BigInt(0), data: operation === "wrap"
    ? encodeFunctionData({ abi: TAO_NATIVE_VAULT_ABI, functionName: "depositLiquid", args: [config.token, BigInt(amount) / BigInt(1_000_000_000)] })
    : encodeFunctionData({ abi: TAO_NATIVE_VAULT_ABI, functionName: "withdrawLiquid", args: [config.token, BigInt(amount), BigInt(amount)] }) };
  return { to: config.token, value: operation === "wrap" ? BigInt(amount) : BigInt(0), data: operation === "wrap"
    ? encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "deposit" })
    : encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "withdraw", args: [BigInt(amount)] }) };
}

// TAO is backed by the issuer's root-subnet stake, not a WETH-style deposit.
// Pin the vault and require exact output; never lower a user's minimum to
// accommodate staking rounding or switch into a subnet alpha asset.
// https://github.com/ForeverMoney-Ai/bridge-contracts/blob/main/src/AlphaVault.sol
export const TAO_NATIVE_VAULT_ABI = parseAbi([
  "function depositLiquid(address token,uint256 minAlphaRao) payable returns(uint256)",
  "function withdrawLiquid(address token,uint256 wad,uint256 minTaoOut) returns(uint256)",
  "function positionOf(address token) view returns(bytes32 validator,uint256 netuid)",
  "function isListed(address token) view returns(bool)",
  "function isPaused() view returns(bool)",
]);
export function assertNativeConversionAmount(chainId: number, amount: string, operation: "wrap" | "unwrap") {
  if (chainId !== 964) return;
  const value = BigInt(amount);
  const minimum = operation === "wrap" ? BigInt("2000000000000000") : BigInt("10000000000000000");
  if (value % BigInt(1_000_000_000) !== BigInt(0)) throw new Error("Native TAO supports at most 9 decimal places.");
  if (value < minimum) throw new Error(`Native TAO requires at least ${operation === "wrap" ? "0.002" : "0.01"} TAO to ${operation} through its staking vault.`);
}
