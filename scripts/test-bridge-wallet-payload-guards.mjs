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

let solanaWalletAddress = "payer";
let solanaBlockhashValid = true;
let solanaConfirmationError = null;
let solanaSimulationError = null;
let afterSolanaSimulation = () => {};
let solanaSignCount = 0;
let confirmedSolanaContext;
const commonJsModule = { exports: {} };
const sandbox = {
  exports: commonJsModule.exports,
  module: commonJsModule,
  window: {
    solana: {
      publicKey: { toBase58: () => solanaWalletAddress },
      signAndSendTransaction: async () => { solanaSignCount++; return { signature: "solana-signature" }; },
    },
    aptos: { account: async () => ({ address: "0x1" }) },
    tronWeb: {
      defaultAddress: { base58: "tron-owner" },
      trx: {},
    },
    starknet: { selectedAddress: "0x1" },
  },
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  require: (specifier) => {
    if (specifier === "@solana/web3.js") {
      return {
        Connection: class Connection {
          async simulateTransaction() { afterSolanaSimulation(); return { value: { err: solanaSimulationError } }; }
          async isBlockhashValid() { return { value: solanaBlockhashValid }; }
          async confirmTransaction(context) { confirmedSolanaContext = context; return { value: { err: solanaConfirmationError } }; }
        },
        PublicKey: class PublicKey {},
        VersionedTransaction: {
          deserialize: () => ({ message: { recentBlockhash: "original-blockhash", staticAccountKeys: [{ toBase58: () => "payer" }] } }),
        },
        clusterApiUrl: () => "https://api.mainnet-beta.solana.com",
      };
    }

    if (specifier === "@mysten/sui/jsonRpc") {
      return {
        SuiJsonRpcClient: class SuiJsonRpcClient {},
        getJsonRpcFullnodeUrl: () => "https://fullnode.mainnet.sui.io:443",
      };
    }

    if (specifier === "@mysten/sui/utils") {
      return {
        SUI_TYPE_ARG: "0x2::sui::SUI",
      };
    }

    if (specifier === "@iota/iota-sdk/client") {
      return {
        IotaClient: class IotaClient {},
        getFullnodeUrl: () => "https://api.mainnet.iota.cafe",
      };
    }

    if (specifier === "@iota/iota-sdk/utils") {
      return {
        IOTA_TYPE_ARG: "0x2::iota::IOTA",
      };
    }

    if (specifier === "@/lib/rpc-config") {
      return {
        getEffectiveRpcUrls: (key, config) => config[key] ?? [`https://${key}.drpc.org`],
        loadRpcConfig: () => ({}),
      };
    }

    throw new Error(`Unexpected require: ${specifier}`);
  },
};

new Script(outputText, { filename: "bridge-wallets.cjs" }).runInNewContext(sandbox);

const {
  executeSolanaUserSteps: rawSolanaUserSteps,
  executeAptosUserSteps: rawAptosUserSteps,
  executeTronUserSteps: rawTronUserSteps,
  executeStarknetUserSteps: rawStarknetUserSteps,
  executeSuiUserSteps,
  executeIotaMoveUserSteps,
  executeTonUserSteps,
} = commonJsModule.exports;
const executeStarknetUserSteps = (steps, account = "0x1") => rawStarknetUserSteps(steps, account);
const executeTronUserSteps = (steps, account = "tron-owner") => rawTronUserSteps(steps, account);
const executeAptosUserSteps = (steps, account = "0x1") => rawAptosUserSteps(steps, account);
const executeSolanaUserSteps = (steps, account = "payer") => rawSolanaUserSteps(steps, account);

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

const directSolanaStep = {
  type: "TRANSACTION", chainType: "SOLANA", transaction: { encoded: {
    encoding: "base64", serializedTransaction: "dHg=", blockhash: "original-blockhash", lastValidBlockHeight: 123,
  } },
};
assert.equal(await executeSolanaUserSteps([directSolanaStep]), "solana-signature");
assert.equal(confirmedSolanaContext.blockhash, "original-blockhash");
assert.equal(confirmedSolanaContext.lastValidBlockHeight, 123);
assert.equal(solanaSignCount, 1);
solanaBlockhashValid = false;
await assert.rejects(executeSolanaUserSteps([directSolanaStep]), /expired/);
assert.equal(solanaSignCount, 1, "expired transactions must not reach the wallet");
solanaBlockhashValid = true;
solanaWalletAddress = "different-wallet";
await assert.rejects(executeSolanaUserSteps([directSolanaStep]), /wallet changed/);
assert.equal(solanaSignCount, 1);
solanaWalletAddress = "payer";
const wrongContext = { ...directSolanaStep, transaction: { encoded: { ...directSolanaStep.transaction.encoded, blockhash: "unrelated-blockhash" } } };
await assert.rejects(executeSolanaUserSteps([wrongContext]), /validity context/);
assert.equal(solanaSignCount, 1);
solanaConfirmationError = { InstructionError: [0, "Custom"] };
await assert.rejects(executeSolanaUserSteps([directSolanaStep]), /Solana transaction failed/);
solanaConfirmationError = null;
await executeSolanaUserSteps([{ ...directSolanaStep, transaction: { encoded: { encoding: "base64", data: "dHg=" } } }]);
assert.equal(confirmedSolanaContext, "solana-signature", "legacy API payloads retain signature-based confirmation");
console.log("Wallet guards: Solana expiry, payer, original blockhash, failed confirmation, and legacy API payloads passed.");

const makeStep = (chainType, encoded) => ({ type: "TRANSACTION", chainType, transaction: { encoded } });
const before = solanaSignCount;
await assert.rejects(executeSolanaUserSteps([directSolanaStep, { type: "SIGNATURE", chainType: "SOLANA" }]), /Unsupported/);
await assert.rejects(executeSolanaUserSteps([directSolanaStep, makeStep("SOLANA", {})]), /Unsupported/);
assert.equal(solanaSignCount, before, "preflight whole plan before first signature");
solanaSimulationError = { InstructionError: [1, "InsufficientFunds"] };
await assert.rejects(executeSolanaUserSteps([directSolanaStep]), /simulation failed/);
assert.equal(solanaSignCount, before);
solanaSimulationError = null;
let aptosCalls = 0;
sandbox.window.aptos.signAndSubmitTransaction = async () => { aptosCalls++; throw new Error("response lost"); };
const aptosStep = makeStep("APTOS", { payload: { function: "0x1::coin::transfer", arguments: ["0x2", "1"] } });
await assert.rejects(executeAptosUserSteps([aptosStep]), /response lost/);
assert.equal(aptosCalls, 1, "never resubmit after uncertain broadcast");
await assert.rejects(executeAptosUserSteps([aptosStep, aptosStep]), /confirmed sequencing/);
assert.equal(aptosCalls, 1);
sandbox.window.aptos.signAndSubmitTransaction = async () => ({ hash: "aptos-hash" });
assert.equal(await executeAptosUserSteps([aptosStep]), "aptos-hash");
sandbox.window.tronWeb.trx.sign = async () => ({ txID: "tron-hash" });
sandbox.window.tronWeb.trx.sendRawTransaction = async () => ({ result: false, message: "rejected" });
await assert.rejects(executeTronUserSteps([makeStep("TRON", { raw_data: {} })]), /rejected/);
sandbox.window.tronWeb.trx.sendRawTransaction = async () => ({ result: true });
assert.equal(await executeTronUserSteps([makeStep("TRON", { raw_data: {} })]), "tron-hash");
let starkCalls = 0;
sandbox.window.starknet.account = { address: "0x1", execute: async () => { starkCalls++; return { transaction_hash: "stark-hash" }; } };
const starkCall = { contractAddress: "0x123", entrypoint: "transfer", calldata: ["0x456", "1"] };
await assert.rejects(executeStarknetUserSteps([makeStep("STARKNET", { calls: [starkCall, {}] })]), /Unsupported/);
assert.equal(starkCalls, 0, "never drop malformed calls from a batch");
assert.equal(await executeStarknetUserSteps([makeStep("STARKNET", { calls: [starkCall] })]), "stark-hash");
for (const [chain, execute] of [["SUI", executeSuiUserSteps], ["IOTAMOVE", executeIotaMoveUserSteps]]) {
 const step = makeStep(chain, { serializedTransaction: "dHg=" });
 await assert.rejects(execute([step], async () => ({ digest: "digest", effects: { status: { status: "failure", error: "MoveAbort" } } })), /MoveAbort/);
 assert.equal(await execute([step], async () => ({ digest: "digest" })), "digest");
}
let tonCalls = 0;
const tonExecute = async () => { tonCalls++; return { boc: "boc" }; };
const tonMessage = { address: "0:" + "1".repeat(64), amount: "1" };
for (const encoded of [{ messages: [tonMessage, {}] }, { messages: [tonMessage], validUntil: 1 }, { messages: [{ ...tonMessage, amount: "-1" }] }, { messages: [tonMessage], network: "-3" }]) {
 await assert.rejects(executeTonUserSteps([makeStep("TON", encoded)], tonExecute), /Unsupported/);
}
assert.equal(tonCalls, 0);
await executeTonUserSteps([makeStep("TON", { messages: [tonMessage] })], tonExecute);
assert.equal(tonCalls, 1);
console.log("All seven non-EVM adapters: preflight, supported payloads, failed submissions/effects, no retry, malformed batches and TON validity passed.");

await assert.rejects(executeSolanaUserSteps([directSolanaStep], "different-owner"), /wallet changed/);
await assert.rejects(executeAptosUserSteps([aptosStep], "0x2"), /wallet changed/);
await assert.rejects(executeTronUserSteps([makeStep("TRON", { raw_data: {} })], "other-owner"), /wallet changed/);
await assert.rejects(executeStarknetUserSteps([makeStep("STARKNET", { calls: [starkCall] })], "0x2"), /wallet changed/);

const signsBeforeAccountSwitch = solanaSignCount;
afterSolanaSimulation = () => { solanaWalletAddress = "switched-during-simulation"; };
await assert.rejects(executeSolanaUserSteps([directSolanaStep]), /wallet changed/);
assert.equal(solanaSignCount, signsBeforeAccountSwitch, "account switch during simulation must stop before signing");
solanaWalletAddress = "payer";
afterSolanaSimulation = () => {};
console.log("Quoted source accounts and Solana account switches during simulation are guarded.");
