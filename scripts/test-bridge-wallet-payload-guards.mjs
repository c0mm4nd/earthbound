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

let solanaWalletAddress = "payer";
let solanaBlockhashValid = true;
let solanaConfirmationError = null;
let solanaSimulationError = null;
let afterSolanaSimulation = () => {};
let solanaSignCount = 0;
let confirmedSolanaSignatures;
const solanaSubmissionEvents = [];
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
          async getSignatureStatuses(signatures) { solanaSubmissionEvents.push("status"); confirmedSolanaSignatures = signatures; return { value: [{ err: solanaConfirmationError, confirmationStatus: "confirmed" }] }; }
          async confirmTransaction() { throw new Error("WebSocket confirmation must not be used"); }
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

    if (specifier === "./solana-confirmation") return confirmationModule.exports;
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
assert.equal(confirmedSolanaSignatures[0], "solana-signature");
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
assert.equal(confirmedSolanaSignatures[0], "solana-signature", "legacy API payloads use HTTP signature status checks");
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

// Explicit Solana wallet selection must remain stable when extensions coexist.
const { connectExternalWallet, disconnectExternalWallet, getSolanaWalletOptions, subscribeSolanaWallet } = commonJsModule.exports;
function makeSolanaWallet(name) {
  const listeners = new Map();
  return {
    isBackpack: name === "Backpack", isPhantom: name === "Phantom",
    publicKey: { toBase58: () => "payer" },
    connects: 0, signs: 0, disconnects: 0, rejectConnect: false,
    async connect() {
      this.connects++;
      if (this.rejectConnect) throw new Error("User rejected connection");
      return { publicKey: this.publicKey };
    },
    async signAndSendTransaction() { this.signs++; return { signature: `${name}-signature` }; },
    async disconnect() { this.disconnects++; this.publicKey = null; this.emit("disconnect"); },
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
}
const backpack = makeSolanaWallet("Backpack");
const phantom = makeSolanaWallet("Phantom");
sandbox.window.backpack = backpack;
sandbox.window.phantom = { solana: phantom };
sandbox.window.solana = phantom;
assert.equal(getSolanaWalletOptions().filter((wallet) => wallet.installed).length, 2);
const connectedBackpack = await connectExternalWallet("SOLANA", "backpack");
assert.equal(connectedBackpack.label, "Backpack");
assert.equal(connectedBackpack.solanaWalletId, "backpack");
assert.equal(phantom.connects, 0);
assert.equal(await rawSolanaUserSteps([directSolanaStep], "payer", connectedBackpack.solanaWalletId), "Backpack-signature");
assert.equal(backpack.signs, 1);
assert.equal(phantom.signs, 0);
const connectedPhantom = await connectExternalWallet("SOLANA", "phantom");
assert.equal(connectedPhantom.label, "Phantom");
assert.equal(await rawSolanaUserSteps([directSolanaStep], "payer", "phantom"), "Phantom-signature");
assert.equal(phantom.signs, 1);
// Rejection must not prompt the other extension.
backpack.rejectConnect = true;
const phantomConnections = phantom.connects;
await assert.rejects(connectExternalWallet("SOLANA", "backpack"), /rejected/);
assert.equal(phantom.connects, phantomConnections);
backpack.rejectConnect = false;
const observedAccounts = [];
const unsubscribe = subscribeSolanaWallet("backpack", (address) => observedAccounts.push(address));
phantom.publicKey = { toBase58: () => "phantom-switched" };
phantom.emit("accountChanged", phantom.publicKey);
assert.deepEqual(observedAccounts, ["payer"]);
backpack.publicKey = { toBase58: () => "backpack-switched" };
backpack.emit("accountChanged", { publicKey: "backpack-switched" });
assert.deepEqual(observedAccounts, ["payer", "backpack-switched"]);
await assert.rejects(rawSolanaUserSteps([directSolanaStep], "payer", "backpack"), /wallet changed/);
assert.equal(backpack.signs, 1);
await disconnectExternalWallet("SOLANA", "backpack");
assert.equal(backpack.disconnects, 1);
assert.equal(phantom.disconnects, 0);
assert.equal(observedAccounts.at(-1), null);
unsubscribe();
backpack.publicKey = { toBase58: () => "payer" };
backpack.emit("accountChanged", { publicKey: "payer" });
assert.equal(observedAccounts.length, 3, "unsubscribed wallet events must be ignored");
// Backpack-only injection and its window.solana alias both work.
delete sandbox.window.phantom;
delete sandbox.window.solana;
assert.equal((await connectExternalWallet("SOLANA")).label, "Backpack");
sandbox.window.solana = backpack;
delete sandbox.window.backpack;
assert.equal((await connectExternalWallet("SOLANA", "backpack")).solanaWalletId, "backpack");
assert.equal(getSolanaWalletOptions().filter((wallet) => wallet.installed).length, 1);
sandbox.window.solana = phantom;
await assert.rejects(connectExternalWallet("SOLANA", "backpack"), /not detected/);
await assert.rejects(rawSolanaUserSteps([directSolanaStep], "payer", "backpack"), /unavailable/);
assert.equal(phantom.signs, 1, "missing selected wallet must never fall back to Phantom");
delete sandbox.window.solana;
assert.equal(getSolanaWalletOptions().some((wallet) => wallet.installed), false);
console.log("Backpack: discovery, explicit selection with Phantom, signing isolation, rejection, disconnect, account events, cleanup, and missing-wallet guards passed.");

// Aptos and Starknet selections must not fall back to the default injection.
const externalCalls = [];
sandbox.window.aptos = { connect: async () => { throw new Error('Wrong Aptos wallet'); } };
sandbox.window.petra = {
  connect: async () => { externalCalls.push('petra:connect'); return { address: '0x1' }; },
  account: async () => ({ address: '0x1' }),
  disconnect: async () => externalCalls.push('petra:disconnect'),
  signAndSubmitTransaction: async () => { externalCalls.push('petra:sign'); return { hash: 'petra-hash' }; },
};
assert.equal((await connectExternalWallet('APTOS', 'petra')).walletId, 'petra');
assert.equal(await commonJsModule.exports.executeAptosUserSteps([aptosStep], '0x1', 'petra'), 'petra-hash');
await disconnectExternalWallet('APTOS', 'petra');
assert.deepEqual(externalCalls, ['petra:connect', 'petra:sign', 'petra:disconnect']);
await assert.rejects(connectExternalWallet('APTOS', 'missing'), /No Aptos wallet/);
sandbox.window.starknet = { request: async () => { throw new Error('Wrong Starknet wallet'); } };
sandbox.window.starknet_braavos = {
  selectedAddress: '0x1',
  enable: async () => externalCalls.push('braavos:connect'),
  disconnect: async () => externalCalls.push('braavos:disconnect'),
  account: { address: '0x1', execute: async () => { externalCalls.push('braavos:sign'); return { transaction_hash: 'braavos-hash' }; } },
};
assert.equal((await connectExternalWallet('STARKNET', 'braavos')).walletId, 'braavos');
assert.equal(await commonJsModule.exports.executeStarknetUserSteps([makeStep('STARKNET', { calls: [starkCall] })], '0x1', 'braavos'), 'braavos-hash');
await disconnectExternalWallet('STARKNET', 'braavos');
assert.deepEqual(externalCalls.slice(3), ['braavos:connect', 'braavos:sign', 'braavos:disconnect']);
await assert.rejects(connectExternalWallet('STARKNET', 'missing'), /No Starknet wallet/);
console.log('Aptos/Starknet: explicit provider selection persists through connection, signing and disconnect; unavailable providers never fall back.');

// Persist the wallet-returned signature before any confirmation request. A wallet
// can replace the blockhash internally, so pre-wallet validity must not leak here.
sandbox.window.phantom = { solana: makeSolanaWallet("Phantom") };
solanaSubmissionEvents.length = 0;
await rawSolanaUserSteps([directSolanaStep], "payer", "phantom", (submission) => {
  assert.equal(submission.signature, "Phantom-signature");
  assert.equal(submission.validity, undefined);
  solanaSubmissionEvents.push("submitted");
});
assert.deepEqual(solanaSubmissionEvents, ["submitted", "status"]);
console.log("Solana submission: signature exposed before HTTP confirmation; wallet-broadcast validity is independent of the original blockhash.");
