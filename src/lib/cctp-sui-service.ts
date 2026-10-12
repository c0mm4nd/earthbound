import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { cctpNetwork } from "./cctp";
import { cctpSuiBurnTransaction, cctpSuiClaimTransaction } from "./cctp-sui";
import type { CctpNativeTransfer } from "./cctp-native-lifecycle";
import type { CctpNativeProof } from "./cctp-native-proof";

export async function prepareCctpSuiTransaction(t: CctpNativeTransfer, payer: string, proof?: CctpNativeProof) {
  const client = new SuiJsonRpcClient({ url: "https://sui-rpc.publicnode.com", network: "mainnet" });
  if (await client.getChainIdentifier() !== "35834a8a") throw new Error("CCTP requires Sui mainnet.");
  let tx;
  if (proof) tx = cctpSuiClaimTransaction(t.recipient, payer, proof.message, proof.attestation);
  else {
    const coinType = cctpNetwork(8).usdc, coins: Array<{ coinObjectId: string; balance: string }> = [];
    const balance = await client.getBalance({ owner: payer, coinType });
    let cursor: string | null | undefined, total = BigInt(0);
    do {
      const page = await client.getCoins({ owner: payer, coinType, cursor, limit: 50 });
      for (const coin of page.data) {
        if (BigInt(coin.balance) > BigInt(0)) { coins.push(coin); total += BigInt(coin.balance); }
        if (total >= BigInt(t.amount)) break;
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
      if (coins.length > 200) throw new Error("Consolidate your USDC coin objects before bridging.");
    } while (cursor && total < BigInt(t.amount));
    tx = cctpSuiBurnTransaction(t, { coins, addressBalance: balance.fundsInAddressBalance ?? "0" });
  }
  const bytes = await tx.build({ client });
  const simulation = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  if (simulation.effects.status.status !== "success") throw new Error(simulation.effects.status.error ?? "Sui CCTP simulation failed.");
  return Buffer.from(bytes).toString("base64");
}
