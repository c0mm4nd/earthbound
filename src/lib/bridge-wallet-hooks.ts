"use client";

import {
  useConnectWallet as useConnectIotaWallet,
  useCurrentWallet as useCurrentIotaWallet,
  useCurrentAccount as useCurrentIotaAccount,
  useDisconnectWallet as useDisconnectIotaWallet,
  useSignAndExecuteTransaction as useSignAndExecuteIotaTransaction,
  useWallets as useIotaWallets,
} from "@iota/dapp-kit";
import {
  useConnectWallet as useConnectSuiWallet,
  useCurrentWallet as useCurrentSuiWallet,
  useCurrentAccount as useCurrentSuiAccount,
  useDisconnectWallet as useDisconnectSuiWallet,
  useSignAndExecuteTransaction as useSignAndExecuteSuiTransaction,
  useWallets as useSuiWallets,
} from "@mysten/dapp-kit";
import { useTonAddress, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { useEffect, useMemo, useState } from "react";
import type { BridgeChainType, QuoteUserStep } from "@/lib/bridge-types";
import {
  connectExternalWallet,
  getExternalWalletOptions,
  disconnectExternalWallet,
  executeAptosUserSteps,
  executeIotaMoveUserSteps,
  executeSolanaUserSteps,
  executeStarknetUserSteps,
  executeSuiUserSteps,
  executeTonUserSteps,
  executeTronUserSteps,
  subscribeSolanaWallet,
  type SolanaWalletId,
} from "@/lib/bridge-wallets";

import type { SolanaSubmission } from "./solana-confirmation";
import { watchCantonWallet } from "./canton-wallet";
import { watchStellarWallet } from "./stellar-wallet";
import { walletIdentifier, type WalletOption } from "@/lib/wallet-options";

export type BridgeWalletSession = {
  chainType: BridgeChainType;
  address: string;
  label: string;
  solanaWalletId?: SolanaWalletId;
  walletId?: string;
};

export function useBridgeWallets() {
  const [manualWalletSessions, setManualWalletSessions] = useState<
    Partial<Record<BridgeChainType, BridgeWalletSession>>
  >({});
  const [manualBusyCount, setManualBusyCount] = useState(0);
  const [tonConnectUI] = useTonConnectUI();
  const tonWallet = useTonWallet();
  const tonFriendlyAddress = useTonAddress();
  const tonRawAddress = useTonAddress(false);

  const suiWallets = useSuiWallets();
  const currentSuiAccount = useCurrentSuiAccount();
  const { currentWallet: currentSuiWallet, isConnected: isSuiWalletConnected } =
    useCurrentSuiWallet();
  const { mutateAsync: connectSuiWallet, isPending: isSuiWalletConnectPending } =
    useConnectSuiWallet();
  const { mutateAsync: disconnectSuiWallet, isPending: isSuiWalletDisconnectPending } =
    useDisconnectSuiWallet();
  const { mutateAsync: signAndExecuteSuiTransaction } = useSignAndExecuteSuiTransaction();

  const iotaWallets = useIotaWallets();
  const currentIotaAccount = useCurrentIotaAccount();
  const { currentWallet: currentIotaWallet, isConnected: isIotaWalletConnected } =
    useCurrentIotaWallet();
  const { mutateAsync: connectIotaWallet, isPending: isIotaWalletConnectPending } =
    useConnectIotaWallet();
  const { mutateAsync: disconnectIotaWallet, isPending: isIotaWalletDisconnectPending } =
    useDisconnectIotaWallet();
  const { mutateAsync: signAndExecuteIotaTransaction } = useSignAndExecuteIotaTransaction();

  async function runManualWalletTask<T>(task: () => Promise<T>) {
    setManualBusyCount((current) => current + 1);

    try {
      return await task();
    } finally {
      setManualBusyCount((current) => Math.max(0, current - 1));
    }
  }

  const suiWalletSession = useMemo(
    () =>
      isSuiWalletConnected && currentSuiWallet && currentSuiAccount?.address
        ? {
            chainType: "SUI" as const,
            address: currentSuiAccount.address,
            walletId: walletIdentifier(currentSuiWallet),
            label: currentSuiWallet.name,
          }
        : null,
    [currentSuiWallet, currentSuiAccount, isSuiWalletConnected],
  );

  const iotaWalletSession = useMemo(
    () =>
      isIotaWalletConnected && currentIotaWallet && currentIotaAccount?.address
        ? {
            chainType: "IOTAMOVE" as const,
            address: currentIotaAccount.address,
            walletId: walletIdentifier(currentIotaWallet),
            label: currentIotaWallet.name,
          }
        : null,
    [currentIotaWallet, currentIotaAccount, isIotaWalletConnected],
  );

  const tonWalletSession = useMemo(
    () =>
      tonWallet?.account.chain === "-239" && (tonFriendlyAddress || tonRawAddress)
        ? {
            chainType: "TON" as const,
            address: tonFriendlyAddress || tonRawAddress,
            label: "device" in tonWallet ? tonWallet.device.appName : "TON Wallet",
          }
        : null,
    [tonFriendlyAddress, tonRawAddress, tonWallet],
  );

  const walletSessionsByChainType = useMemo(() => {
    const nextWalletSessions: Partial<Record<BridgeChainType, BridgeWalletSession>> = {
      ...manualWalletSessions,
    };

    if (suiWalletSession) {
      nextWalletSessions.SUI = suiWalletSession;
    } else {
      delete nextWalletSessions.SUI;
    }

    if (iotaWalletSession) {
      nextWalletSessions.IOTAMOVE = iotaWalletSession;
    } else {
      delete nextWalletSessions.IOTAMOVE;
    }

    if (tonWalletSession) {
      nextWalletSessions.TON = tonWalletSession;
    } else {
      delete nextWalletSessions.TON;
    }

    return nextWalletSessions;
  }, [iotaWalletSession, manualWalletSessions, suiWalletSession, tonWalletSession]);

  const solanaWalletId = manualWalletSessions.SOLANA?.solanaWalletId;
  useEffect(() => {
    if (!solanaWalletId) return;
    return subscribeSolanaWallet(solanaWalletId, (address) => {
      setManualWalletSessions((current) => {
        const session = current.SOLANA;
        if (session?.solanaWalletId !== solanaWalletId || session.address === address) return current;
        if (address) return { ...current, SOLANA: { ...session, address } };
        const next = { ...current };
        delete next.SOLANA;
        return next;
      });
    });
  }, [solanaWalletId]);

  const cantonWalletId = manualWalletSessions.CANTON?.walletId;
  useEffect(() => {
    if (!cantonWalletId) return;
    return watchCantonWallet(address => setManualWalletSessions(current => {
      const session = current.CANTON;
      if (!session || session.walletId !== cantonWalletId || session.address === address) return current;
      if (address) return { ...current, CANTON: { ...session, address } };
      const next = { ...current }; delete next.CANTON; return next;
    }));
  }, [cantonWalletId]);

  const stellarWalletId = manualWalletSessions.STELLAR?.walletId;
  useEffect(() => {
    if (stellarWalletId !== "freighter") return;
    return watchStellarWallet((address) => {
      setManualWalletSessions(current => {
        const session = current.STELLAR;
        if (session?.walletId !== stellarWalletId || session.address === address) return current;
        if (address) return { ...current, STELLAR: { ...session, address } };
        const next = { ...current }; delete next.STELLAR; return next;
      });
    });
  }, [stellarWalletId]);

  async function connectWallet(chainType: BridgeChainType | undefined | null, walletId?: string) {
    switch (chainType) {
      case "SOLANA":
      case "APTOS":
      case "CANTON":
      case "TRON":
      case "STARKNET":
      case "STELLAR": {
        return runManualWalletTask(async () => {
          if (!walletId) throw new Error("Select a wallet to connect.");
          if (manualWalletSessions[chainType]) await disconnectWallet(chainType);
          const walletSession = await connectExternalWallet(chainType, walletId);

          setManualWalletSessions((current) => ({
            ...current,
            [chainType]: {
              chainType,
              address: walletSession.address,
              label: walletSession.label,
              solanaWalletId: walletSession.solanaWalletId,
              walletId: walletSession.walletId,
            },
          }));
        });
      }
      case "SUI": {
        const wallet = suiWallets.find((candidate) => walletIdentifier(candidate) === walletId);

        if (!wallet) {
          throw new Error("No Sui wallet found. Install Slush, Suiet, or a compatible wallet.");
        }

        if (isSuiWalletConnected) await disconnectSuiWallet();
        const result = await connectSuiWallet({ wallet });
        if (!result.accounts.length) throw new Error("The selected wallet has no available accounts.");
        return;
      }
      case "IOTAMOVE": {
        const wallet = iotaWallets.find((candidate) => walletIdentifier(candidate) === walletId);

        if (!wallet) {
          throw new Error("No IOTA wallet found. Install a compatible IOTA wallet.");
        }

        if (isIotaWalletConnected) await disconnectIotaWallet();
        const result = await connectIotaWallet({ wallet });
        if (!result.accounts.length) throw new Error("The selected wallet has no available accounts.");
        return;
      }
      case "TON": {
        if (tonWallet) await tonConnectUI.disconnect();
        tonConnectUI.setConnectionNetwork("-239");
        await tonConnectUI.openModal();
        return;
      }
      default:
        throw new Error("Unsupported wallet type.");
    }
  }

  async function disconnectWallet(chainType: BridgeChainType | undefined | null) {
    switch (chainType) {
      case "SOLANA":
      case "APTOS":
      case "CANTON":
      case "TRON":
      case "STARKNET":
      case "STELLAR": {
        return runManualWalletTask(async () => {
          try {
            await disconnectExternalWallet(chainType, manualWalletSessions[chainType]?.walletId);
          } finally {
            setManualWalletSessions((current) => {
              const nextWalletSessions = { ...current };
              delete nextWalletSessions[chainType];
              return nextWalletSessions;
            });
          }
        });
      }
      case "SUI":
        await disconnectSuiWallet();
        return;
      case "IOTAMOVE":
        await disconnectIotaWallet();
        return;
      case "TON":
        await tonConnectUI.disconnect();
        return;
      default:
        return;
    }
  }

  async function executeUserSteps(
    chainType: BridgeChainType | undefined | null,
    userSteps: QuoteUserStep[],
    expectedAccount: string,
    onSubmitted?: (submission: SolanaSubmission) => void,
    lifecycle?: { beforeSign?: () => void; submitted?: (hash: string) => void },
  ) {
    if (!expectedAccount) throw new Error("Connect the source wallet and refresh the quote.");
    if (["APTOS", "TRON", "STARKNET", "STELLAR"].includes(chainType ?? "")) {
      const session = manualWalletSessions[chainType!];
      if (!session?.walletId || session.address !== expectedAccount) {
        throw new Error("Source wallet changed. Reconnect and refresh the quote.");
      }
    }
    switch (chainType) {
      case "SOLANA": {
        const session = manualWalletSessions.SOLANA;
        if (!session?.solanaWalletId || session.address !== expectedAccount) {
          throw new Error("Solana wallet changed. Reconnect and refresh the quote.");
        }
        return executeSolanaUserSteps(userSteps, expectedAccount, session.solanaWalletId, onSubmitted, lifecycle?.beforeSign);
      }
      case "APTOS":
        return executeAptosUserSteps(userSteps, expectedAccount, manualWalletSessions.APTOS?.walletId, lifecycle);
      case "TRON":
        return executeTronUserSteps(userSteps, expectedAccount);
      case "STARKNET":
        return executeStarknetUserSteps(userSteps, expectedAccount, manualWalletSessions.STARKNET?.walletId, lifecycle);
      case "STELLAR":
        return (await import("./cctp-stellar-wallet")).executeStellarCctpSteps(userSteps, expectedAccount, lifecycle);
      case "TON":
        if (tonWallet?.account.chain !== "-239") throw new Error("Connect a TON mainnet wallet before sending.");
        if (expectedAccount !== tonFriendlyAddress && expectedAccount !== tonRawAddress)
          throw new Error("TON wallet changed. Refresh the quote.");
        if (tonConnectUI.account?.address !== tonWallet.account.address || tonConnectUI.account?.chain !== "-239")
          throw new Error("TON wallet changed. Refresh the quote.");
        return executeTonUserSteps(userSteps, (request) => tonConnectUI.sendTransaction({
          ...request, network: tonWallet.account.chain, from: tonWallet.account.address,
        }));
      case "SUI": {
        const account = currentSuiAccount;
        if (!account || account.address !== expectedAccount) throw new Error("Source wallet changed. Refresh the quote.");
        return executeSuiUserSteps(userSteps, ({ transaction, chain }) =>
          signAndExecuteSuiTransaction({ transaction, chain, account }),
          lifecycle,
        );
      }
      case "IOTAMOVE": {
        const account = currentIotaAccount;
        if (!account || account.address !== expectedAccount) throw new Error("Source wallet changed. Refresh the quote.");
        return executeIotaMoveUserSteps(userSteps, ({ transaction, chain }) =>
          signAndExecuteIotaTransaction({ transaction, chain, account }),
        );
      }
      default:
        throw new Error("Unsupported execution chain type.");
    }
  }

  function getWalletOptions(chainType: BridgeChainType): WalletOption[] {
    if (chainType === "SUI") return suiWallets.map((wallet) => ({ id: walletIdentifier(wallet), label: wallet.name, installed: true }));
    if (chainType === "IOTAMOVE") return iotaWallets.map((wallet) => ({ id: walletIdentifier(wallet), label: wallet.name, installed: true }));
    if (chainType === "TON") return [{ id: "tonconnect", label: "TON Connect", installed: true }];
    return getExternalWalletOptions(chainType);
  }

  const isPending =
    manualBusyCount > 0 ||
    isSuiWalletConnectPending ||
    isSuiWalletDisconnectPending ||
    isIotaWalletConnectPending ||
    isIotaWalletDisconnectPending;

  return {
    walletSessionsByChainType,
    getWalletOptions,
    isPending,
    connectWallet,
    disconnectWallet,
    executeUserSteps,
  };
}
