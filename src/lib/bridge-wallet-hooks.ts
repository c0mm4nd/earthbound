"use client";

import {
  useConnectWallet as useConnectIotaWallet,
  useCurrentWallet as useCurrentIotaWallet,
  useDisconnectWallet as useDisconnectIotaWallet,
  useSignAndExecuteTransaction as useSignAndExecuteIotaTransaction,
  useWallets as useIotaWallets,
} from "@iota/dapp-kit";
import {
  useConnectWallet as useConnectSuiWallet,
  useCurrentWallet as useCurrentSuiWallet,
  useDisconnectWallet as useDisconnectSuiWallet,
  useSignAndExecuteTransaction as useSignAndExecuteSuiTransaction,
  useWallets as useSuiWallets,
} from "@mysten/dapp-kit";
import { useTonAddress, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { useMemo, useState } from "react";
import type { BridgeChainType, QuoteUserStep } from "@/lib/bridge-types";
import {
  connectExternalWallet,
  disconnectExternalWallet,
  executeAptosUserSteps,
  executeIotaMoveUserSteps,
  executeSolanaUserSteps,
  executeStarknetUserSteps,
  executeSuiUserSteps,
  executeTonUserSteps,
  executeTronUserSteps,
} from "@/lib/bridge-wallets";

export type BridgeWalletSession = {
  chainType: BridgeChainType;
  address: string;
  label: string;
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
  const { currentWallet: currentSuiWallet, isConnected: isSuiWalletConnected } =
    useCurrentSuiWallet();
  const { mutateAsync: connectSuiWallet, isPending: isSuiWalletConnectPending } =
    useConnectSuiWallet();
  const { mutateAsync: disconnectSuiWallet, isPending: isSuiWalletDisconnectPending } =
    useDisconnectSuiWallet();
  const { mutateAsync: signAndExecuteSuiTransaction } = useSignAndExecuteSuiTransaction();

  const iotaWallets = useIotaWallets();
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
      isSuiWalletConnected && currentSuiWallet?.accounts[0]?.address
        ? {
            chainType: "SUI" as const,
            address: currentSuiWallet.accounts[0].address,
            label: currentSuiWallet.name,
          }
        : null,
    [currentSuiWallet, isSuiWalletConnected],
  );

  const iotaWalletSession = useMemo(
    () =>
      isIotaWalletConnected && currentIotaWallet?.accounts[0]?.address
        ? {
            chainType: "IOTAMOVE" as const,
            address: currentIotaWallet.accounts[0].address,
            label: currentIotaWallet.name,
          }
        : null,
    [currentIotaWallet, isIotaWalletConnected],
  );

  const tonWalletSession = useMemo(
    () =>
      tonWallet && (tonFriendlyAddress || tonRawAddress)
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

  async function connectWallet(chainType: BridgeChainType | undefined | null) {
    switch (chainType) {
      case "SOLANA":
      case "APTOS":
      case "TRON":
      case "STARKNET": {
        return runManualWalletTask(async () => {
          const walletSession = await connectExternalWallet(chainType);

          setManualWalletSessions((current) => ({
            ...current,
            [chainType]: {
              chainType,
              address: walletSession.address,
              label: walletSession.label,
            },
          }));
        });
      }
      case "SUI": {
        if (isSuiWalletConnected) {
          return;
        }

        const wallet = suiWallets[0];

        if (!wallet) {
          throw new Error("No Sui wallet found. Install Slush, Suiet, or a compatible wallet.");
        }

        await connectSuiWallet({ wallet });
        return;
      }
      case "IOTAMOVE": {
        if (isIotaWalletConnected) {
          return;
        }

        const wallet = iotaWallets[0];

        if (!wallet) {
          throw new Error("No IOTA wallet found. Install a compatible IOTA wallet.");
        }

        await connectIotaWallet({ wallet });
        return;
      }
      case "TON": {
        if (tonWallet) {
          return;
        }

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
      case "TRON":
      case "STARKNET": {
        return runManualWalletTask(async () => {
          await disconnectExternalWallet(chainType);
          setManualWalletSessions((current) => {
            const nextWalletSessions = { ...current };
            delete nextWalletSessions[chainType];
            return nextWalletSessions;
          });
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
  ) {
    switch (chainType) {
      case "SOLANA":
        return executeSolanaUserSteps(userSteps);
      case "APTOS":
        return executeAptosUserSteps(userSteps);
      case "TRON":
        return executeTronUserSteps(userSteps);
      case "STARKNET":
        return executeStarknetUserSteps(userSteps);
      case "TON":
        return executeTonUserSteps(userSteps, (request) => tonConnectUI.sendTransaction(request));
      case "SUI":
        return executeSuiUserSteps(userSteps, ({ transaction, chain }) =>
          signAndExecuteSuiTransaction({ transaction, chain }),
        );
      case "IOTAMOVE":
        return executeIotaMoveUserSteps(userSteps, ({ transaction, chain }) =>
          signAndExecuteIotaTransaction({ transaction, chain }),
        );
      default:
        throw new Error("Unsupported execution chain type.");
    }
  }

  const isPending =
    manualBusyCount > 0 ||
    isSuiWalletConnectPending ||
    isSuiWalletDisconnectPending ||
    isIotaWalletConnectPending ||
    isIotaWalletDisconnectPending;

  return {
    walletSessionsByChainType,
    isPending,
    connectWallet,
    disconnectWallet,
    executeUserSteps,
  };
}
