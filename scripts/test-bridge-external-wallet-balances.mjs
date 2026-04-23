import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/bridge-wallets.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

const calls = [];
const commonJsModule = { exports: {} };
const sandbox = {
  exports: commonJsModule.exports,
  module: commonJsModule,
  window: {
    solana: {
      publicKey: {
        toBase58: () => "solana-owner",
      },
    },
  },
  require: (specifier) => {
    if (specifier === "@solana/web3.js") {
      return {
        Connection: class Connection {
          constructor(url, commitment) {
            calls.push(["connection", url, commitment]);
          }

          async getBalance(publicKey) {
            calls.push(["getBalance", publicKey.toBase58()]);
            return 1234567890;
          }

          async getParsedTokenAccountsByOwner(owner, filter) {
            calls.push(["getParsedTokenAccountsByOwner", owner.toBase58(), filter.mint.toBase58()]);
            const tokenBalances = {
              DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT: ["42000000000", "8000000000"],
              Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN: ["123000000000"],
            };
            const balances = tokenBalances[filter.mint.toBase58()] ?? ["42", "8"];
            return {
              value: balances.map((amount) => ({
                account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
              })),
            };
          }
        },
        PublicKey: class PublicKey {
          constructor(value) {
            this.value = value;
          }

          toBase58() {
            return this.value;
          }
        },
        VersionedTransaction: {
          deserialize: () => ({}),
        },
        clusterApiUrl: () => "https://api.mainnet-beta.solana.com",
      };
    }

    if (specifier === "@/lib/rpc-config") {
      return {
        loadRpcConfig: () => ({
          solana: ["https://custom-solana.example"],
          sui: ["https://custom-sui.example"],
          iota: ["https://custom-iota.example"],
        }),
      };
    }

    if (specifier === "@mysten/sui/jsonRpc") {
      return {
        SuiJsonRpcClient: class SuiJsonRpcClient {
          constructor(options) {
            calls.push(["sui-client", options.url]);
          }

          async getBalance({ owner, coinType }) {
            calls.push(["sui-getBalance", owner, coinType]);
            return { totalBalance: coinType === "0x2::sui::SUI" ? "900" : "91" };
          }
        },
        getJsonRpcFullnodeUrl: () => "https://sui-mainnet.example",
      };
    }

    if (specifier === "@mysten/sui/utils") {
      return {
        SUI_TYPE_ARG: "0x2::sui::SUI",
      };
    }

    if (specifier === "@iota/iota-sdk/client") {
      return {
        IotaClient: class IotaClient {
          constructor(options) {
            calls.push(["iota-client", options.url]);
          }

          async getBalance({ owner, coinType }) {
            calls.push(["iota-getBalance", owner, coinType]);
            return { totalBalance: coinType === "0x2::iota::IOTA" ? "700" : "71" };
          }
        },
        getFullnodeUrl: () => "https://iota-mainnet.example",
      };
    }

    if (specifier === "@iota/iota-sdk/utils") {
      return {
        IOTA_TYPE_ARG: "0x2::iota::IOTA",
      };
    }

    throw new Error(`Unexpected require: ${specifier}`);
  },
};

new Script(outputText, { filename: "bridge-wallets.cjs" }).runInNewContext(sandbox);

const { fetchExternalWalletBalance } = commonJsModule.exports;

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "SOLANA",
    account: "solana-owner",
    tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }),
  1234567890n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "SOLANA",
    account: "solana-owner",
    tokenAddress: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
  }),
  50000000000n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "SOLANA",
    account: "solana-owner",
    tokenAddress: "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN",
  }),
  123000000000n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "SUI",
    account: "sui-owner",
    tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }),
  900n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "SUI",
    account: "sui-owner",
    tokenAddress: "0x123::coin::COIN",
  }),
  91n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "IOTAMOVE",
    account: "iota-owner",
    tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }),
  700n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "IOTAMOVE",
    account: "iota-owner",
    tokenAddress: "0x456::coin::COIN",
  }),
  71n,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "APTOS",
    account: "aptos-owner",
    tokenAddress: "0xf37a8864fe737eb8ec2c2931047047cbaed1beed3fb0e5b7c5526dafd3b9c2e9",
  }),
  undefined,
);

assert.equal(
  await fetchExternalWalletBalance({
    chainType: "TON",
    account: "ton-owner",
    tokenAddress: "0x086fa2a675f74347b08dd4606a549b8fdb98829cb282bc1949d3b12fbaed9dcc",
  }),
  undefined,
);

assert.deepEqual(calls, [
  ["connection", "https://custom-solana.example", "confirmed"],
  ["getBalance", "solana-owner"],
  ["connection", "https://custom-solana.example", "confirmed"],
  [
    "getParsedTokenAccountsByOwner",
    "solana-owner",
    "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
  ],
  ["connection", "https://custom-solana.example", "confirmed"],
  [
    "getParsedTokenAccountsByOwner",
    "solana-owner",
    "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN",
  ],
  ["sui-client", "https://custom-sui.example"],
  ["sui-getBalance", "sui-owner", "0x2::sui::SUI"],
  ["sui-client", "https://custom-sui.example"],
  ["sui-getBalance", "sui-owner", "0x123::coin::COIN"],
  ["iota-client", "https://custom-iota.example"],
  ["iota-getBalance", "iota-owner", "0x2::iota::IOTA"],
  ["iota-client", "https://custom-iota.example"],
  ["iota-getBalance", "iota-owner", "0x456::coin::COIN"],
]);
