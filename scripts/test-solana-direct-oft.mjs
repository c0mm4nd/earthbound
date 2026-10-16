import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import ts from "typescript";
import { PublicKey } from "@solana/web3.js";

import { createPublicClient, http, toHex, decodeFunctionData } from "viem";

const require = createRequire(import.meta.url);
function load(name, overrides = {}) {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  const commonJsModule = { exports: {} };
  new Script(outputText).runInNewContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    btoa,
    atob,
    require: (id) =>
      overrides[id] ??
      (id === "./direct-oft-solana-discovery" ? { discoverSolanaOftStores: async () => [] } : undefined) ??
      (id.startsWith("./") ? load(id.slice(2), overrides) : require(id)),
  });
  return commonJsModule.exports;
}
const { buildLayerZeroExecutorLzReceiveOption, layerZeroOftV2Abi } =
  load("custom-oft");
const { receiveOptionValue, solanaRentExtraOptions } =
  load("direct-oft-solana");
const options = buildLayerZeroExecutorLzReceiveOption(80000n, 1000000n);
assert.equal(receiveOptionValue(options), 1000000n);
assert.equal(
  receiveOptionValue(solanaRentExtraOptions(2039280n, options)),
  1039280n,
);
assert.equal(solanaRentExtraOptions(100n, options), "0x");
assert.throws(() => receiveOptionValue("0x000301002101"), /Truncated/);
const solMint = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const solStore = new PublicKey(new Uint8Array(32).fill(8));
const solWallet = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const evmToken = "0x0000000000000000000000000000000000000001";
const evmOft = "0x0000000000000000000000000000000000000002";
const evmWallet = "0x0000000000000000000000000000000000000003";
const evmBytes = `0x${evmOft.slice(2).padStart(64, "0")}`;
const nativeCurrency = { symbol: "ETH", decimals: 18 };
const evmChain = { chainKey: "ethereum", chainType: "EVM", nativeCurrency };
const solChain = {
  chainKey: "solana",
  chainType: "SOLANA",
  nativeCurrency: { symbol: "SOL", decimals: 9 },
};
const eToken = { address: evmToken, decimals: 18, symbol: "TEST" };
const sToken = { address: solMint, decimals: 9, symbol: "TEST" };
const metadata = {
  TEST: [
    {
      endpointVersion: "v2",
      deployments: {
        ethereum: { address: evmOft, innerTokenAddress: evmToken },
        solana: { address: solMint },
      },
    },
  ],
};
let destinationChecked = false;
let destinationAmount;
let solSend;
const solAdapter = {
  addressBytes32: toHex(solStore.toBytes()),
  tokenAddress: solMint,
  decimals: 9,
  sharedDecimals: 6,
  peer: evmBytes,
  enforcedOptions: buildLayerZeroExecutorLzReceiveOption(65000n),
  receiveOptions: async (recipient) => {
    assert.equal(recipient, solWallet);
    destinationChecked = true;
    return options;
  },
  validateReceive: async (recipient, amountLD) => {
    assert.equal(recipient, solWallet);
    destinationAmount = amountLD;
  },
  quoteOft: async (p) => ({
    minAmountLD: 1n,
    maxAmountLD: 100000000000n,
    amountSentLD: p.amountLD,
    amountReceivedLD: p.amountLD,
  }),
  quoteSend: async () => ({ nativeFee: 777n, lzTokenFee: 0n }),
  buildSteps: async (p) => {
    solSend = p;
    return [
      {
        type: "TRANSACTION",
        chainType: "SOLANA",
        chainKey: "solana",
        transaction: {
          encoded: { encoding: "base64", serializedTransaction: "fixture" },
        },
      },
    ];
  },
};
const { buildDirectOftQuote, directOftAddressMatches, directOftRecipient } =
  load("direct-oft", {
    "./direct-oft-solana": {
      createSolanaOftAdapter: async ({ storeAddress }) => {
        assert.equal(storeAddress, solStore.toBase58());
        return solAdapter;
      },
    },
  });
assert.equal(
  directOftAddressMatches("SOLANA", solMint, solMint.toLowerCase()),
  false,
);
assert.equal(directOftAddressMatches("EVM", "0xABC", "0xabc"), true);
assert.equal(
  directOftRecipient("SOLANA", solWallet),
  toHex(new PublicKey(solWallet).toBytes()),
);
const read = async ({ functionName, args }) => {
  switch (functionName) {
    case "peers":
      return toHex(solStore.toBytes());
    case "token":
      return evmToken;
    case "sharedDecimals":
      return 6;
    case "approvalRequired":
      return false;
    case "enforcedOptions":
      return options;
    case "decimals":
      return 18;
    case "quoteOFT":
      return [
        { minAmountLD: 1n, maxAmountLD: 10n ** 20n },
        [],
        { amountSentLD: args[0].amountLD, amountReceivedLD: args[0].amountLD },
      ];
    case "quoteSend":
      return { nativeFee: 123n, lzTokenFee: 0n };
    default:
      throw new Error(functionName);
  }
};
const forward = await buildDirectOftQuote({
  metadata,
  srcChain: evmChain,
  dstChain: solChain,
  srcToken: eToken,
  dstToken: sToken,
  from: evmWallet,
  to: solWallet,
  amount: 10n ** 18n,
  read,
});
assert.equal(destinationChecked, true);
assert.equal(destinationAmount, 1000000000n);
assert.equal(forward.dstAmount, "1000000000");
const validateReceive = solAdapter.validateReceive;
solAdapter.validateReceive = async () => { throw new Error("Destination receive limit exceeded"); };
await assert.rejects(buildDirectOftQuote({ metadata, srcChain: evmChain, dstChain: solChain,
  srcToken: eToken, dstToken: sToken, from: evmWallet, to: solWallet, amount: 10n ** 18n, read }), /Destination receive limit exceeded/);
solAdapter.validateReceive = validateReceive;
const calldata = decodeFunctionData({
  abi: layerZeroOftV2Abi,
  data: forward.userSteps[0].transaction.encoded.data,
});
assert.equal(calldata.args[0].to, toHex(new PublicKey(solWallet).toBytes()));
assert.equal(calldata.args[0].extraOptions, options);
const reverseArgs = {
  metadata,
  srcChain: solChain,
  dstChain: evmChain,
  srcToken: sToken,
  dstToken: eToken,
  from: solWallet,
  to: evmWallet,
  amount: 10n ** 9n,
  read,
};
const reverse = await buildDirectOftQuote({ ...reverseArgs, simulate: true });
assert.equal(reverse.dstAmount, "1000000000000000000");
assert.equal(reverse.directOft.nativeFee, "777");
assert.equal(reverse.fees[0].symbol, "SOL");
assert.equal(solSend.to, `0x${evmWallet.slice(2).padStart(64, "0")}`);
assert.equal(reverse.userSteps[0].chainType, "SOLANA");
// A valid route must remain quotable before the wallet is funded. The same
// failure must still stop execution's fresh, simulated quote before signing.
const buildSolanaSteps = solAdapter.buildSteps;
for (const message of [
  "Source Solana token account does not exist.",
  "Source Solana token account is frozen.",
  "Insufficient token balance in the source Solana token account.",
]) {
  let buildCalls = 0;
  solAdapter.buildSteps = async () => { buildCalls++; throw new Error(message); };
  for (const amount of [1_000_000n, 1_000_000_000n, 20_000_000_000n]) {
    const preview = await buildDirectOftQuote({ ...reverseArgs, amount });
    assert.equal(preview.userSteps.length, 0, "preview must not build a Solana send");
    assert.equal(preview.directOft.nativeFee, "777");
    assert.ok(BigInt(preview.dstAmount) > 0n);
  }
  assert.equal(buildCalls, 0, "preview must not inspect source token funding");
  await assert.rejects(buildDirectOftQuote({ ...reverseArgs, simulate: true }), { message });
  assert.equal(buildCalls, 1, "execution must still validate the source account");
}
solAdapter.buildSteps = buildSolanaSteps;
console.log("Solana fee previews bypass send-account funding checks; execution retains fresh validation.");
const discoveryRead = (params) => {
  if (params.address.toLowerCase() === evmToken.toLowerCase() && params.functionName === "token") throw new Error("Token is not the OFT adapter");
  return read(params);
};
const discoveryArgs = { metadata: {}, discoverPeers: true, srcChain: evmChain, dstChain: solChain, srcToken: eToken, dstToken: sToken,
  from: evmWallet, to: solWallet, amount: 10n ** 18n, read: discoveryRead,
  fetchDiscoveryQuote: async () => ({ quotes: [{ userSteps: forward.userSteps }] }),
};
const discoveredSolana = await buildDirectOftQuote(discoveryArgs);
assert.equal(discoveredSolana.dstAmount, forward.dstAmount);
assert.equal(discoveredSolana.userSteps.at(-1).transaction.encoded.to, evmOft);
solAdapter.peer = `0x${"00".repeat(32)}`;
await assert.rejects(buildDirectOftQuote(discoveryArgs), /No direct OFT mesh/);
solAdapter.peer = evmBytes;
const { buildDirectOftQuote: buildConsoleQuote } = load("direct-oft", {
  "./direct-oft-solana": { createSolanaOftAdapter: async () => solAdapter },
  "./direct-oft-solana-discovery": { discoverSolanaOftStores: async () => [solStore.toBase58()] },
});
const consoleArgs = { ...discoveryArgs, srcChain: solChain, dstChain: evmChain, srcToken: sToken, dstToken: eToken,
  from: solWallet, to: evmWallet, amount: 10n ** 9n,
  fetchDiscoveryQuote: async () => { throw new Error("Unexpected API call"); } };
assert.equal((await buildConsoleQuote(consoleArgs)).dstAmount, reverse.dstAmount);
await assert.rejects(buildConsoleQuote({ ...consoleArgs, read: (p) => p.functionName === "token" ? Promise.resolve(evmWallet) : discoveryRead(p) }), /destination token/);
await assert.rejects(buildConsoleQuote({ ...consoleArgs, read: (p) => p.functionName === "peers" ? Promise.resolve('0x' + '00'.repeat(32)) : discoveryRead(p) }), /reverse peer/);
console.log("Solana discovery: verified API hints, mint-authority source discovery, reciprocal peers, token identity and fresh direct quotes passed.");
solAdapter.peer = `0x${"00".repeat(32)}`;
await assert.rejects(
  buildDirectOftQuote({
    metadata,
    srcChain: evmChain,
    dstChain: solChain,
    srcToken: eToken,
    dstToken: sToken,
    from: evmWallet,
    to: solWallet,
    amount: 1n,
    read,
  }),
  /peers/,
);
console.log(
  "Solana direct OFT: case-sensitive matching, recipients, rent, bidirectional decimals, fees, and peer validation passed.",
);

if (process.env.LIVE_SOLANA_OFT === "1") {
  const m = await (
    await fetch(
      "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=APE&chainNames=ethereum,solana",
    )
  ).json();
  const variant = m.APE.find(
    (v) =>
      v.endpointVersion === "v2" &&
      v.deployments.ethereum &&
      v.deployments.solana,
  );
  const client = createPublicClient({
    transport: http("https://eth.drpc.org", {
      timeout: 15000,
      retryCount: 0,
    }),
  });
  const live = await load("direct-oft").buildDirectOftQuote({
    metadata: { APE: [variant] },
    srcChain: evmChain,
    dstChain: solChain,
    srcToken: {
      ...eToken,
      address:
        variant.deployments.ethereum.innerTokenAddress ??
        variant.deployments.ethereum.address,
      symbol: "APE",
    },
    dstToken: {
      ...sToken,
      address: variant.deployments.solana.address,
      symbol: "APE",
    },
    from: evmWallet,
    to: solWallet,
    amount: 10n ** 18n,
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    read: ({ address, abi, functionName, args }) =>
      client.readContract({ address, abi, functionName, args }),
  });
  console.log(
    "Mainnet EVM → Solana read-only:",
    JSON.stringify({
      srcAmount: live.srcAmount,
      dstAmount: live.dstAmount,
      fees: live.fees,
    }),
  );
  // Optionally use a supplied funded public holder for signature-disabled simulation.
  // No wallet connection, signature, or broadcast is performed.
  const simulationOwner = process.env.SOLANA_SIMULATION_OWNER;
  if (!simulationOwner) {
    console.log(
      "Reverse mainnet simulation skipped: set SOLANA_SIMULATION_OWNER to a funded public APE holder address (no private key).",
    );
    process.exit(0);
  }
  const reverseLive = await load("direct-oft").buildDirectOftQuote({
    metadata: { APE: [variant] },
    srcChain: solChain,
    dstChain: evmChain,
    srcToken: {
      ...sToken,
      address: variant.deployments.solana.address,
      symbol: "APE",
    },
    dstToken: {
      ...eToken,
      address:
        variant.deployments.ethereum.innerTokenAddress ??
        variant.deployments.ethereum.address,
      symbol: "APE",
    },
    from: simulationOwner,
    to: evmWallet,
    amount: 1000000000n,
    simulate: true,
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    read: ({ address, abi, functionName, args }) =>
      client.readContract({ address, abi, functionName, args }),
  });
  console.log(
    "Mainnet Solana → EVM quote and unsigned send simulation:",
    JSON.stringify({
      srcAmount: reverseLive.srcAmount,
      dstAmount: reverseLive.dstAmount,
      fees: reverseLive.fees,
    }),
  );
}
