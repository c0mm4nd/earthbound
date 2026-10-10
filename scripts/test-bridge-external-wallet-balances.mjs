import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const confirmationModule = { exports: {} };
new Script(ts.transpileModule(readFileSync(new URL("../src/lib/solana-confirmation.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText).runInNewContext({ module: confirmationModule, exports: confirmationModule.exports, setTimeout });

const source = readFileSync(new URL("../src/lib/bridge-wallets.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

const calls = [];
let indexedError;
let fallbackMissing = false;
let fallbackFrozen = false;
let fallbackWrongOwner = false;
const key = (value) => ({ toBase58: () => value, equals: (other) => other.toBase58() === value });
const tokenProgram = key("token-2022-program");
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
            if (indexedError) throw indexedError;
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

          async getAccountInfo(address) {
            calls.push(["getAccountInfo", address.toBase58()]);
            if (address.toBase58() === "test-mint") return { owner: tokenProgram };
            return fallbackMissing ? null : { owner: tokenProgram };
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

    if (specifier === "@solana/spl-token") {
      return {
        TOKEN_PROGRAM_ID: key("token-program"),
        TOKEN_2022_PROGRAM_ID: tokenProgram,
        getAssociatedTokenAddressSync: (mint, owner, allowOffCurve, program) => {
          assert.equal(mint.toBase58(), "test-mint");
          assert.equal(owner.toBase58(), "solana-owner");
          assert.equal(allowOffCurve, true);
          assert.equal(program, tokenProgram);
          return key("test-ata");
        },
        unpackAccount: () => ({
          owner: key(fallbackWrongOwner ? "wrong-owner" : "solana-owner"),
          mint: key("test-mint"), isInitialized: true, isFrozen: fallbackFrozen, amount: 123456n,
        }),
      };
    }

    if (specifier === "@/lib/rpc-config") {
      return {
        getEffectiveRpcUrls: (key, config) => config[key] ?? [`https://${key}.drpc.org`],
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

    if (specifier === "./solana-confirmation") return confirmationModule.exports;
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

indexedError = new Error("403: Indexed requests require a personal token.");
const request = { chainType: "SOLANA", account: "solana-owner", tokenAddress: "test-mint" };
assert.equal(await fetchExternalWalletBalance(request), 123456n);
assert.deepEqual(calls.slice(-2), [["getAccountInfo", "test-mint"], ["getAccountInfo", "test-ata"]]);
fallbackMissing = true;
assert.equal(await fetchExternalWalletBalance(request), 0n);
fallbackMissing = false;
fallbackFrozen = true;
assert.equal(await fetchExternalWalletBalance(request), 0n);
fallbackFrozen = false;
fallbackWrongOwner = true;
await assert.rejects(fetchExternalWalletBalance(request), /Invalid Solana associated token account/);
indexedError = new Error("network timeout");
await assert.rejects(fetchExternalWalletBalance(request), /network timeout/);
console.log("External balances: indexed balances, Token-2022 ATA fallback, missing/frozen accounts, owner checks, and RPC errors passed.");
