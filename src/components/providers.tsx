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
import { WagmiProvider, type Config } from "wagmi";
import { createWagmiConfig } from "@/lib/wagmi";
import { loadRpcConfig, saveRpcConfig, type RpcConfig } from "@/lib/rpc-config";

const { networkConfig: suiNetworkConfig } = createSuiNetworkConfig({
  mainnet: {
    network: "mainnet",
    url: getJsonRpcFullnodeUrl("mainnet"),
  },
});

const { networkConfig: iotaNetworkConfig } = createIotaNetworkConfig({
  mainnet: {
    url: getFullnodeUrl("mainnet"),
  },
});

type RpcConfigContextValue = {
  wagmiConfig: Config;
  rpcConfig: RpcConfig;
  updateRpcConfig: (config: RpcConfig) => void;
};

const RpcConfigContext = createContext<RpcConfigContextValue | null>(null);

export function useRpcConfig() {
  const ctx = useContext(RpcConfigContext);
  if (!ctx) throw new Error("useRpcConfig must be used within Providers");
  return ctx;
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
  const [wagmiConfigKey, setWagmiConfigKey] = useState(0);
  const wagmiConfigRef = useRef<Config>(createWagmiConfig(rpcConfig));

  const updateRpcConfig = useCallback((config: RpcConfig) => {
    saveRpcConfig(config);
    setRpcConfig(config);
    wagmiConfigRef.current = createWagmiConfig(config);
    setWagmiConfigKey((k) => k + 1);
  }, []);

  const rpcContextValue = useMemo(
    () => ({ wagmiConfig: wagmiConfigRef.current, rpcConfig, updateRpcConfig }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wagmiConfigKey, rpcConfig, updateRpcConfig],
  );

  return (
    <RpcConfigContext.Provider value={rpcContextValue}>
      <WagmiProvider key={wagmiConfigKey} config={wagmiConfigRef.current}>
        <QueryClientProvider client={queryClient}>
          <SuiClientProvider networks={suiNetworkConfig} defaultNetwork="mainnet">
            <SuiWalletProvider autoConnect>
              <IotaClientProvider networks={iotaNetworkConfig} defaultNetwork="mainnet">
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
