"use client";

import { isCcipAddress } from "./ccip-addresses";
import type { PrepareExecuteParams, TxChangedEvent, Wallet } from "@canton-network/dapp-sdk";

// Load the official SDK only when Canton is selected. Its wallet picker handles
// CIP-0103 discovery; credentials remain managed by the connected wallet.
let sdkPromise: Promise<typeof import("@canton-network/dapp-sdk")> | undefined;
const getSdk = () => sdkPromise ??= import("@canton-network/dapp-sdk");
export function cantonPrimaryAccount(accounts: Wallet[]) {
  const account = accounts.find(account => account.primary && !account.disabled && account.status === "allocated");
  if (!account || !isCcipAddress("CANTON", account.partyId)) throw new Error("Select an allocated Canton primary account in your wallet.");
  if (account.networkId !== "canton:da-mainnet") throw new Error("Switch the Canton wallet to mainnet.");
  return account;
}

export async function connectCantonWallet() {
  const sdk = await getSdk();
  await sdk.init();
  const result = await sdk.connect();
  if (!result.isConnected) throw new Error("Canton wallet connection was cancelled.");
  const account = cantonPrimaryAccount(await sdk.listAccounts());
  return { address: account.partyId, label: "Canton", walletId: "canton-official" };
}

export async function disconnectCantonWallet() { await (await getSdk()).disconnect(); }

export function watchCantonWallet(onChange: (address: string | null) => void) {
  let disposed = false;
  let cleanup: (() => void) | undefined;
  void getSdk().then(async sdk => {
    const changed = () => { void sdk.listAccounts().then(accounts => {
      if (disposed) return;
      try { onChange(cantonPrimaryAccount(accounts).partyId); } catch { onChange(null); }
    }).catch(() => { if (!disposed) onChange(null); }); };
    await sdk.onAccountsChanged(changed);
    await sdk.onStatusChanged(changed);
    cleanup = () => { void sdk.removeOnAccountsChanged(changed); void sdk.removeOnStatusChanged(changed); };
    if (disposed) cleanup();
  }).catch(() => { if (!disposed) onChange(null); });
  return () => { disposed = true; cleanup?.(); };
}

export function assertCantonCommandParty(commands: PrepareExecuteParams, party: string) {
  if (!isCcipAddress("CANTON", party) || commands.actAs?.length !== 1 || commands.actAs[0] !== party ||
      commands.readAs?.some(value => value !== party) || !commands.commandId || commands.commands.length !== 1) {
    throw new Error("Canton transaction does not match the connected party.");
  }
}

export async function sendCantonCommands(commands: PrepareExecuteParams, expectedParty: string, lifecycle: {
  beforeSign: () => void; pending: (commandId: string) => void; submitted: (updateId: string) => void;
}) {
  assertCantonCommandParty(commands, expectedParty);
  const sdk = await getSdk();
  if (cantonPrimaryAccount(await sdk.listAccounts()).partyId !== expectedParty) throw new Error("Canton account changed. Refresh the transfer.");
  lifecycle.beforeSign();
  const listener = (tx: TxChangedEvent) => {
    if (tx.commandId !== commands.commandId) return;
    if (tx.status === "signed" || tx.status === "pending") lifecycle.pending(commands.commandId!);
    if (tx.status === "executed") lifecycle.submitted(tx.payload.updateId);
  };
  await sdk.onTxChanged(listener);
  try {
    const result = await sdk.prepareExecuteAndWait(commands);
    if (result.tx.commandId !== commands.commandId) throw new Error("Canton wallet returned a different command.");
    lifecycle.submitted(result.tx.payload.updateId);
    return result.tx.payload.updateId;
  } finally { await sdk.removeOnTxChanged(listener); }
}
