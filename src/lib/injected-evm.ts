import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

type InjectedEvmRequestArguments = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

type InjectedEvmProvider = {
  request(args: InjectedEvmRequestArguments): Promise<unknown>;
};

type ProviderRpcError = Error & {
  code?: number;
  data?: unknown;
};

declare global {
  interface Window {
    ethereum?: InjectedEvmProvider;
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function getInjectedEvmProvider() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No injected EVM wallet found.");
  }

  return window.ethereum;
}

export async function switchInjectedEvmChain(chainId: number, chainName: string) {
  try {
    await getInjectedEvmProvider().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHex(chainId) }],
    });
  } catch (error) {
    const providerError = error as ProviderRpcError;

    if (providerError.code === 4902) {
      throw new Error(
        `${chainName} is not added in the current wallet. Add it there first, then retry.`,
      );
    }

    throw error;
  }
}

export async function readInjectedEvmContract<T>({
  abi,
  address,
  args,
  functionName,
}: {
  abi: Abi;
  address: Address;
  args?: readonly unknown[];
  functionName: string;
}) {
  const data = await getInjectedEvmProvider().request({
    method: "eth_call",
    params: [
      {
        to: address,
        data: encodeFunctionData({
          abi,
          functionName,
          args,
        }),
      },
      "latest",
    ],
  });

  return decodeFunctionResult({
    abi,
    functionName,
    data: data as Hex,
  }) as T;
}

export async function fetchInjectedEvmBalance({
  account,
  tokenAddress,
}: {
  account: Address;
  tokenAddress?: Address | null;
}) {
  if (!tokenAddress) {
    const balance = await getInjectedEvmProvider().request({
      method: "eth_getBalance",
      params: [account, "latest"],
    });

    return BigInt(balance as Hex);
  }

  const balance = await readInjectedEvmContract<bigint>({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });

  return balance;
}

export async function sendInjectedEvmTransaction({
  data,
  from,
  gas,
  to,
  value,
}: {
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
}) {
  const hash = await getInjectedEvmProvider().request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to,
        data,
        value: toHex(value ?? BigInt(0)),
        gas: gas ? toHex(gas) : undefined,
      },
    ],
  });

  return hash as string;
}

export async function waitForInjectedEvmTransactionReceipt(
  hash: string,
  options: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 1_250;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await getInjectedEvmProvider().request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });

    if (receipt) {
      return receipt;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Timed out while waiting for the EVM transaction receipt.");
}
