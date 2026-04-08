"use client";

import {
  createNetworkConfig as createIotaNetworkConfig,
  IotaClientProvider,
  WalletProvider as IotaWalletProvider,
} from "@iota/dapp-kit";
import { getFullnodeUrl } from "@iota/iota-sdk/client";
import {
  createNetworkConfig as createSuiNetworkConfig,
  SuiClientProvider,
  WalletProvider as SuiWalletProvider,
} from "@mysten/dapp-kit";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Chain } from "viem";
import { WagmiProvider, type Config } from "wagmi";
import { createWagmiConfig, walletChains } from "@/lib/wagmi";
import { viemChainById } from "@/lib/viem-chains-by-id";
import { loadRpcConfig, saveRpcConfig, getEffectiveRpcUrls, type RpcConfig } from "@/lib/rpc-config";

type RpcConfigContextValue = {
  wagmiConfig: Config;
  rpcConfig: RpcConfig;
  updateRpcConfig: (config: RpcConfig) => void;
  evmChains: readonly Chain[];
  updateBridgeEvmChains: (chainIds: number[]) => void;
};

const RpcConfigContext = createContext<RpcConfigContextValue | null>(null);

export function useRpcConfig() {
  const ctx = useContext(RpcConfigContext);
  if (!ctx) throw new Error("useRpcConfig must be used within Providers");
  return ctx;
}

function buildSuiNetworkConfig(rpcConfig: RpcConfig) {
  return createSuiNetworkConfig({
    mainnet: {
      network: "mainnet",
      url: getEffectiveRpcUrls("sui", rpcConfig)[0] ?? getJsonRpcFullnodeUrl("mainnet"),
    },
  }).networkConfig;
}

function buildIotaNetworkConfig(rpcConfig: RpcConfig) {
  return createIotaNetworkConfig({
    mainnet: {
      url: getEffectiveRpcUrls("iota", rpcConfig)[0] ?? getFullnodeUrl("mainnet"),
    },
  }).networkConfig;
}

export function Providers({
  children,
  tonManifestUrl,
}: {
  children: React.ReactNode;
  tonManifestUrl: string;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [rpcConfig, setRpcConfig] = useState<RpcConfig>(() => loadRpcConfig());
  const [configKey, setConfigKey] = useState(0);
  const [evmChains, setEvmChains] = useState<readonly Chain[]>(() => walletChains);
  const evmChainsRef = useRef<readonly Chain[]>(walletChains);
  const wagmiConfigRef = useRef<Config>(createWagmiConfig(walletChains, rpcConfig));
  const suiNetworkConfigRef = useRef(buildSuiNetworkConfig(rpcConfig));
  const iotaNetworkConfigRef = useRef(buildIotaNetworkConfig(rpcConfig));

  // Keep ref in sync with state so callbacks can always read the latest value
  evmChainsRef.current = evmChains;

  const updateRpcConfig = useCallback((config: RpcConfig) => {
    saveRpcConfig(config);
    setRpcConfig(config);
    wagmiConfigRef.current = createWagmiConfig(evmChainsRef.current, config);
    suiNetworkConfigRef.current = buildSuiNetworkConfig(config);
    iotaNetworkConfigRef.current = buildIotaNetworkConfig(config);
    setConfigKey((k) => k + 1);
  }, []);

  const updateBridgeEvmChains = useCallback((chainIds: number[]) => {
    // Look up each chainId in viemChainById, merge with walletChains (dedup by id)
    const walletChainIds = new Set<number>(walletChains.map((c) => c.id as number));
    const extra: Chain[] = [];
    for (const id of chainIds) {
      if (!walletChainIds.has(id)) {
        const chain = viemChainById[id];
        if (chain) {
          extra.push(chain);
        }
      }
    }
    const merged: readonly Chain[] = [...walletChains, ...extra];

    // Bail out if the chain set hasn't changed. This prevents an infinite remount
    // loop: when WagmiProvider remounts (due to key change), BridgeApp also remounts
    // and its useEffect re-fires with the same evmChainIdsDep, which would call this
    // function again and trigger another remount.
    const currentIds = new Set(evmChainsRef.current.map((c) => c.id));
    const mergedIds = new Set(merged.map((c) => c.id));
    if (
      currentIds.size === mergedIds.size &&
      [...mergedIds].every((id) => currentIds.has(id))
    ) {
      return;
    }

    setEvmChains(merged);
    setRpcConfig((currentRpcConfig) => {
      wagmiConfigRef.current = createWagmiConfig(merged, currentRpcConfig);
      return currentRpcConfig;
    });
    setConfigKey((k) => k + 1);
  }, []);

  const rpcContextValue = useMemo(
    () => ({
      wagmiConfig: wagmiConfigRef.current,
      rpcConfig,
      updateRpcConfig,
      evmChains,
      updateBridgeEvmChains,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configKey, rpcConfig, updateRpcConfig, evmChains, updateBridgeEvmChains],
  );

  return (
    <RpcConfigContext.Provider value={rpcContextValue}>
      <WagmiProvider key={`wagmi-${configKey}`} config={wagmiConfigRef.current}>
        <QueryClientProvider client={queryClient}>
          <SuiClientProvider
            key={`sui-${configKey}`}
            networks={suiNetworkConfigRef.current}
            defaultNetwork="mainnet"
          >
            <SuiWalletProvider autoConnect>
              <IotaClientProvider
                key={`iota-${configKey}`}
                networks={iotaNetworkConfigRef.current}
                defaultNetwork="mainnet"
              >
                <IotaWalletProvider autoConnect>
                  <TonConnectUIProvider manifestUrl={tonManifestUrl}>
                    {children}
                  </TonConnectUIProvider>
                </IotaWalletProvider>
              </IotaClientProvider>
            </SuiWalletProvider>
          </SuiClientProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </RpcConfigContext.Provider>
  );
}
