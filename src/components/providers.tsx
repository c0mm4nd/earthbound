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
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

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

  return (
    <WagmiProvider config={wagmiConfig}>
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
  );
}
