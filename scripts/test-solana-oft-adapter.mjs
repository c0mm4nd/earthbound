import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import * as web3 from "@solana/web3.js";
import { publicKey } from "@metaplex-foundation/umi";
import { oft, OftPDA } from "@layerzerolabs/oft-v2-solana-sdk";
import {
  TOKEN_PROGRAM_ID,
  MintLayout,
  AccountLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { toHex } from "viem";
const require = createRequire(import.meta.url);
const pk = (n) => new web3.PublicKey(new Uint8Array(32).fill(n));
const owner = web3.Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const program = pk(3);
const mint = pk(4);
const escrow = pk(5);
const pda = new OftPDA(publicKey(program.toBase58()));
const store = new web3.PublicKey(pda.oftStore(publicKey(escrow.toBase58()))[0]);
const peer = new web3.PublicKey(
  pda.peer(publicKey(store.toBase58()), 30101)[0],
);
const ata = getAssociatedTokenAddressSync(mint, owner);
const sourceAmount = 1000000000n;
const nativeFee = 777n;
let simulationError = null;
let simulationCalls = 0;
const info = (ownerKey, data, executable = false) => ({
  owner: ownerKey,
  data: Buffer.from(data),
  executable,
  lamports: 1000000000,
});
const storeData = oft.accounts.getOFTStoreAccountDataSerializer().serialize({
  oftType: 0,
  ld2sdRate: 1000n,
  tokenMint: publicKey(mint.toBase58()),
  tokenEscrow: publicKey(escrow.toBase58()),
  endpointProgram: publicKey(pk(6).toBase58()),
  bump: pda.oftStore(publicKey(escrow.toBase58()))[1],
  tvlLd: 0n,
  admin: publicKey(owner.toBase58()),
  defaultFeeBps: 0,
  paused: false,
  pauser: null,
  unpauser: null,
});
const peerData = oft.accounts.getPeerConfigAccountDataSerializer().serialize({
  peerAddress: new Uint8Array(32).fill(1),
  enforcedOptions: { send: new Uint8Array(), sendAndCall: new Uint8Array() },
  outboundRateLimiter: null,
  inboundRateLimiter: null,
  feeBps: null,
  bump: 1,
});
const mintData = Buffer.alloc(MintLayout.span);
MintLayout.encode(
  {
    mintAuthorityOption: 1,
    mintAuthority: store,
    supply: sourceAmount * 10n,
    decimals: 9,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: pk(0),
  },
  mintData,
);
const tokenData = Buffer.alloc(AccountLayout.span);
AccountLayout.encode(
  {
    mint,
    owner,
    amount: sourceAmount * 2n,
    delegateOption: 0,
    delegate: pk(0),
    state: 1,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: pk(0),
  },
  tokenData,
);
const accounts = new Map([
  [store.toBase58(), info(program, storeData)],
  [peer.toBase58(), info(program, peerData)],
  [program.toBase58(), info(pk(11), [], true)],
  [mint.toBase58(), info(TOKEN_PROGRAM_ID, mintData)],
  [ata.toBase58(), info(TOKEN_PROGRAM_ID, tokenData)],
]);
const mockConnection = class {
  async getAccountInfo(key) {
    return accounts.get(key.toBase58()) ?? null;
  }
  async getMinimumBalanceForRentExemption(size) {
    assert.equal(size, 165);
    return 2039280;
  }
  async getLatestBlockhash() {
    return { blockhash: pk(12).toBase58(), lastValidBlockHeight: 12345 };
  }
  async getAddressLookupTable(key) {
    return {
      value: new web3.AddressLookupTableAccount({
        key,
        state: {
          deactivationSlot: 18446744073709551615n,
          lastExtendedSlot: 1,
          lastExtendedSlotStartIndex: 0,
          addresses: [],
        },
      }),
    };
  }
  async simulateTransaction(tx, options) {
    assert.equal(options.sigVerify, false);
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), owner.toBase58());
    simulationCalls++;
    return { value: { err: simulationError } };
  }
};
const mockOft = {
  ...oft,
  quoteOft: async (_rpc, accountArgs, params) => {
    assert.equal(accountArgs.tokenMint, mint.toBase58());
    assert.equal(params.amountLd, sourceAmount);
    return {
      oftLimits: { minAmountLd: 1n, maxAmountLd: 10n ** 12n },
      oftReceipt: {
        amountSentLd: sourceAmount,
        amountReceivedLd: sourceAmount,
      },
      oftFeeDetails: [],
    };
  },
  quote: async (_rpc, _accounts, params) => {
    assert.equal(params.payInLzToken, false);
    return { nativeFee, lzTokenFee: 0n };
  },
  send: async (_rpc, accountArgs, params, programs) => {
    assert.equal(accountArgs.tokenSource, ata.toBase58());
    assert.equal(programs.oft, program.toBase58());
    assert.equal(params.amountLd, sourceAmount);
    assert.equal(params.nativeFee, nativeFee);
    return {
      instruction: {
        programId: publicKey(program.toBase58()),
        keys: [
          {
            pubkey: publicKey(owner.toBase58()),
            isSigner: true,
            isWritable: true,
          },
        ],
        data: new Uint8Array([1, 2, 3]),
      },
      signers: [],
      bytesCreatedOnChain: 0,
    };
  },
};
function load(name) {
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
    require: (id) =>
      id === "@solana/web3.js"
        ? { ...web3, Connection: mockConnection }
        : id === "@metaplex-foundation/umi-bundle-defaults"
          ? { createUmi: () => ({ rpc: {} }) }
          : id === "@layerzerolabs/oft-v2-solana-sdk"
            ? { oft: mockOft, OftPDA }
            : id.startsWith("./")
              ? load(id.slice(2))
              : require(id),
  });
  return commonJsModule.exports;
}
const { createSolanaOftAdapter, receiveOptionValue } =
  load("direct-oft-solana");
const { buildLayerZeroExecutorLzReceiveOption } = load("custom-oft");
const args = {
  storeAddress: store.toBase58(),
  deployment: {
    address: mint.toBase58(),
    details: { oftProgramId: program.toBase58() },
  },
  token: { address: mint.toBase58(), decimals: 9 },
  remoteEid: 30101,
  from: owner.toBase58(),
  simulate: true,
};
const adapter = await createSolanaOftAdapter(args);
assert.equal(adapter.decimals, 9);
assert.equal(adapter.sharedDecimals, 6);
assert.equal(adapter.addressBytes32, toHex(store.toBytes()));
const sendParam = {
  dstEid: 30101,
  to: `0x${"01".repeat(32)}`,
  amountLD: sourceAmount,
  minAmountLD: sourceAmount,
  extraOptions: "0x",
  composeMsg: "0x",
  oftCmd: "0x",
};
assert.equal(
  (await adapter.quoteOft(sendParam)).amountReceivedLD,
  sourceAmount,
);
const fee = await adapter.quoteSend(sendParam);
const [step] = await adapter.buildSteps(sendParam, fee);
const tx = web3.VersionedTransaction.deserialize(
  Buffer.from(step.transaction.encoded.serializedTransaction, "base64"),
);
assert.equal(tx.message.recentBlockhash, step.transaction.encoded.blockhash);
assert.equal(step.transaction.encoded.lastValidBlockHeight, 12345);
assert.equal(tx.message.header.numRequiredSignatures, 1);
assert.ok(
  tx.signatures[0].every((byte) => byte === 0),
  "adapter must never sign",
);
assert.equal(simulationCalls, 1);
const enforced = buildLayerZeroExecutorLzReceiveOption(80000n, 1000000n);
assert.equal(await adapter.receiveOptions(owner.toBase58(), enforced), "0x");
accounts.delete(ata.toBase58());
assert.equal(
  receiveOptionValue(await adapter.receiveOptions(owner.toBase58(), enforced)),
  1039280n,
);
await assert.rejects(adapter.buildSteps(sendParam, fee), /does not exist/);
accounts.set(ata.toBase58(), info(TOKEN_PROGRAM_ID, tokenData));
simulationError = { InstructionError: [1, "Custom"] };
await assert.rejects(adapter.buildSteps(sendParam, fee), /simulation failed/);
await assert.rejects(
  createSolanaOftAdapter({ ...args, token: { address: pk(20).toBase58() } }),
  /mint/,
);
await assert.rejects(
  createSolanaOftAdapter({
    ...args,
    deployment: {
      ...args.deployment,
      details: { oftProgramId: pk(21).toBase58() },
    },
  }),
  /program/,
);
accounts.set(store.toBase58(), info(program, new Uint8Array(179)));
await assert.rejects(createSolanaOftAdapter(args), /unsupported store layout/);
console.log(
  "Solana adapter: account validation, source quote, ATA rent, unsigned v0 serialization, expiry context, simulation failure, and custom-layout rejection passed.",
);
