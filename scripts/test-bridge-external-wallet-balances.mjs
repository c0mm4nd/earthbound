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
            return {
              value: [
                { account: { data: { parsed: { info: { tokenAmount: { amount: "42" } } } } } },
                { account: { data: { parsed: { info: { tokenAmount: { amount: "8" } } } } } },
              ],
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
        loadRpcConfig: () => ({ solana: ["https://custom-solana.example"] }),
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
    tokenAddress: "spl-token-mint",
  }),
  50n,
);

assert.deepEqual(calls, [
  ["connection", "https://custom-solana.example", "confirmed"],
  ["getBalance", "solana-owner"],
  ["connection", "https://custom-solana.example", "confirmed"],
  ["getParsedTokenAccountsByOwner", "solana-owner", "spl-token-mint"],
]);
