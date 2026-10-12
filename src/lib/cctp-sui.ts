import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { type Hex } from "viem";
import { nativeCctpBurnArgs, type CctpNativeIntent } from "./cctp-native";
import { cctpNetwork } from "./cctp";
import { assertCctpNativeDestination } from "./cctp-native-proof";

// https://developers.circle.com/cctp/references/sui-packages
export const CCTP_SUI = {
  transmitter: "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87",
  messenger: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  handler: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
  transmitterState: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
  messengerState: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
  handlerState: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
  treasury: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
};
const usdc = cctpNetwork(8).usdc, c = CCTP_SUI;
export function cctpSuiBurnTransaction(t: CctpNativeIntent, funding?: { coins: Array<{ coinObjectId: string; balance: string }>; addressBalance: string }) {
  const a = nativeCctpBurnArgs(t, 8), tx = new Transaction(); tx.setSender(t.sender);
  let coin;
  if (funding) {
    const total = funding.coins.reduce((sum, c) => sum + BigInt(c.balance), BigInt(0));
    const withdrawal = a.amount > total ? a.amount - total : BigInt(0);
    if (withdrawal > BigInt(funding.addressBalance)) throw new Error("Insufficient native USDC balance.");
    const coins: TransactionObjectArgument[] = funding.coins.map(c => tx.object(c.coinObjectId));
    if (withdrawal) coins.push(tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [usdc], arguments: [tx.withdrawal({ amount: withdrawal, type: usdc })] })[0]);
    if (!coins.length) throw new Error("No USDC available to burn.");
    const primary = coins[0];
    if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1));
    [coin] = tx.splitCoins(primary, [tx.pure.u64(a.amount)]);
    // A coin produced by redeem_funds must also be consumed, even if empty.
    if (!funding.coins.length) tx.transferObjects([primary], t.sender);
  } else {
    [coin] = tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [usdc], arguments: [tx.withdrawal({ amount: a.amount, type: usdc })] });
  }
  const [receipt, returnedCoin] = tx.moveCall({ target: `${c.messenger}::deposit_for_burn::deposit_for_burn`, typeArguments: [usdc],
    arguments: [coin, tx.pure.u32(t.destinationDomain), tx.pure.address(a.mintRecipient), tx.pure.address(a.destinationCaller),
      tx.pure.u256(a.maxFee), tx.pure.u32(t.finality), tx.pure.vector("u8", [...Buffer.from(a.hook.slice(2), "hex")]), tx.object(c.messengerState)] });
  const [ticket] = tx.moveCall({ target: `${c.handler}::handler::burn`, arguments: [tx.object(c.handlerState), receipt, returnedCoin, tx.object("0x403"), tx.object(c.treasury)] });
  tx.moveCall({ target: `${c.messenger}::deposit_for_burn::complete_burn`, typeArguments: [usdc, `${c.handler}::handler::Auth`],
    arguments: [ticket, tx.object(c.messengerState), tx.object(c.transmitterState)] });
  return tx;
}
export function cctpSuiClaimTransaction(recipient: string, payer: string, message: Hex, attestation: Hex) {
  const proof = assertCctpNativeDestination(8, recipient, message, attestation);
  const tx = new Transaction(); tx.setSender(payer);
  const [receipt] = tx.moveCall({ target: `${c.transmitter}::receive_message::receive_message`, arguments: [tx.pure.vector("u8", [...proof.message]), tx.pure.vector("u8", [...proof.attestation]), tx.object(c.transmitterState)] });
  const [mintReceipt] = tx.moveCall({ target: `${c.messenger}::handle_receive_message::prepare_mint`, typeArguments: [usdc], arguments: [receipt, tx.object(c.messengerState), tx.object("0x6")] });
  const [ticket] = tx.moveCall({ target: `${c.handler}::handler::mint`, arguments: [tx.object(c.handlerState), mintReceipt, tx.object(c.messengerState), tx.object(c.treasury), tx.object("0x403")] });
  tx.moveCall({ target: `${c.messenger}::handle_receive_message::complete_mint`, typeArguments: [usdc, `${c.handler}::handler::Auth`], arguments: [ticket, tx.object(c.messengerState), tx.object(c.transmitterState)] });
  return tx;
}
