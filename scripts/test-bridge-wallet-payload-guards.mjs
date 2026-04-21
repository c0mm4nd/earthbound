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

const commonJsModule = { exports: {} };
const sandbox = {
  exports: commonJsModule.exports,
  module: commonJsModule,
  window: {
    solana: {
      signAndSendTransaction: async () => ({ signature: "solana-signature" }),
    },
    aptos: {},
    tronWeb: {
      trx: {},
    },
    starknet: {},
  },
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  require: (specifier) => {
    if (specifier === "@solana/web3.js") {
      return {
        Connection: class Connection {},
        VersionedTransaction: {
          deserialize: () => ({}),
        },
        clusterApiUrl: () => "https://api.mainnet-beta.solana.com",
      };
    }

    if (specifier === "@/lib/rpc-config") {
      return {
        loadRpcConfig: () => ({}),
      };
    }

    throw new Error(`Unexpected require: ${specifier}`);
  },
};

new Script(outputText, { filename: "bridge-wallets.cjs" }).runInNewContext(sandbox);

const {
  executeSolanaUserSteps,
  executeAptosUserSteps,
  executeTronUserSteps,
  executeStarknetUserSteps,
  executeSuiUserSteps,
  executeIotaMoveUserSteps,
  executeTonUserSteps,
} = commonJsModule.exports;

await assert.rejects(
  () => executeSolanaUserSteps([{ type: "TRANSACTION", chainType: "SOLANA" }]),
  /Unsupported Solana transaction payload\./,
);

await assert.rejects(
  () => executeAptosUserSteps([{ type: "TRANSACTION", chainType: "APTOS" }]),
  /Unsupported Aptos transaction payload\./,
);

await assert.rejects(
  () => executeTronUserSteps([{ type: "TRANSACTION", chainType: "TRON" }]),
  /Unsupported Tron transaction payload\./,
);

await assert.rejects(
  () => executeStarknetUserSteps([{ type: "TRANSACTION", chainType: "STARKNET" }]),
  /Unsupported Starknet transaction payload\./,
);

await assert.rejects(
  () => executeSuiUserSteps([{ type: "TRANSACTION", chainType: "SUI" }], async () => ({})),
  /Unsupported SUI transaction payload\./,
);

await assert.rejects(
  () => executeIotaMoveUserSteps([{ type: "TRANSACTION", chainType: "IOTAMOVE" }], async () => ({})),
  /Unsupported IOTAMOVE transaction payload\./,
);

await assert.rejects(
  () => executeTonUserSteps([{ type: "TRANSACTION", chainType: "TON" }], async () => ({ boc: "boc" })),
  /Unsupported TON transaction payload\./,
);
