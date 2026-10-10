import { keccak256, type Address, type Hex } from "viem";
import type { LayerZeroOftV2SendParam } from "./custom-oft";

// peaq's native Balances pallet exposes ERC-20 approval/transferFrom at 2057.
// This is a chain-scoped native-asset alias, not a wrapped token or an address
// alias on other networks. Source: peaqnetwork/peaq-network-node,
// runtime/peaq/src/precompiles.rs (NativeErc20Metadata / AddressU64<2057>).
export function isNativeErc20Precompile(chainId: number | undefined, address: string) {
  return chainId === 3338 && address.toLowerCase() === "0x0000000000000000000000000000000000000809";
}

// These immutable, verified NativeOFTAdapter deployments inherit an old
// OFTCore.quoteOFT that calls IERC20(address(0)).totalSupply() and always reverts.
// Their actual _debitView only removes dust and checks slippage. Pin the entire
// runtime (including immutables), never infer that behavior from token() alone.
// https://sonicscan.org/address/0xc2c08bef6c3659018aff49917a8cbe551a1decaa#code
// https://seiscan.io/address/0xbdf43ecadc5cef51b7d1772f722e40596bc1788b#code
const LEGACY_NATIVE: Record<string, Hex> = {
  "146:0xc2c08bef6c3659018aff49917a8cbe551a1decaa": "0x3c791fb3e4d2d5bda90e96ed43b676a980518c8e472dde8d20a4f7187e47148a",
  "1329:0xbdf43ecadc5cef51b7d1772f722e40596bc1788b": "0x6dba8afe448f3cd29e3e1e274ffe70cb9bc3dde86b5ebb049397e43ff8f4243b",
};

export async function quoteLegacyNativeOft(args: {
  chainId: number; address: Address; decimals: number; sharedDecimals: number;
  params: LayerZeroOftV2SendParam; readCode?: () => Promise<Hex | undefined>;
}) {
  const expected = LEGACY_NATIVE[`${args.chainId}:${args.address.toLowerCase()}`];
  if (!expected || !args.readCode) return null;
  const code = await args.readCode();
  if (!code || keccak256(code) !== expected) return null;
  if (args.decimals !== 18 || args.sharedDecimals !== 6) throw new Error("Legacy native OFT decimals changed.");
  const conversion = BigInt(10) ** BigInt(12);
  const amount = args.params.amountLD / conversion * conversion;
  if (amount < args.params.minAmountLD) throw new Error("Native OFT amount is below the minimum received.");
  return { minAmountLD: BigInt(0), maxAmountLD: ((BigInt(1) << BigInt(64)) - BigInt(1)) * conversion,
    amountSentLD: amount, amountReceivedLD: amount };
}
