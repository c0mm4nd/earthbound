// Mainnet reads and signature-disabled simulation only. Never signs or broadcasts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import ts from "typescript";
import { createPublicClient, http } from "viem";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";

if (process.env.LIVE_USDG_OFT !== "1") {
  console.log("Set LIVE_USDG_OFT=1 to run USDG mainnet reads and unsigned simulation.");
  process.exit(0);
}
const require = createRequire(import.meta.url);
function load(name) {
  const mod = { exports: {} };
  new Script(ts.transpileModule(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ module: mod, exports: mod.exports, btoa, atob,
    require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id) });
  return mod.exports;
}
const { buildDirectOftQuote } = load("direct-oft");
const { solanaOftTokenAccountSize } = load("solana-token-extensions");
const rpc = process.env.SOLANA_RPC_URL ?? load("rpc-config").DEFAULT_RPC_URLS.solana[0];
const connection = new Connection(rpc, "confirmed");
const metadata = await (await fetch("https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=USDG&chainNames=ethereum,solana")).json();
const mesh = metadata.USDG.find((item) => item.endpointVersion === "v2" && item.deployments.ethereum && item.deployments.solana);
assert.ok(mesh, "USDG Ethereum/Solana mesh exists");
const evmChain = { chainKey: "ethereum", chainType: "EVM", nativeCurrency: { symbol: "ETH", decimals: 18 } };
const solChain = { chainKey: "solana", chainType: "SOLANA", nativeCurrency: { symbol: "SOL", decimals: 9 } };
const evmToken = { address: mesh.deployments.ethereum.innerTokenAddress ?? mesh.deployments.ethereum.address, decimals: 6, symbol: "USDG" };
const solToken = { address: mesh.deployments.solana.address, decimals: 6, symbol: "USDG" };
const evmWallet = "0x0000000000000000000000000000000000000001";
const recipient = new PublicKey(randomBytes(32));
const client = createPublicClient({ transport: http("https://eth.drpc.org", { timeout: 15000, retryCount: 0 }) });
const common = { metadata, solanaRpcUrl: rpc, amount: 1000000n, read: ({ address, abi, functionName, args }) => client.readContract({ address, abi, functionName, args }) };
const forward = await buildDirectOftQuote({ ...common, srcChain: evmChain, dstChain: solChain, srcToken: evmToken, dstToken: solToken, from: evmWallet, to: recipient.toBase58() });
assert.equal(forward.dstAmount, "1000000");
console.log("Ethereum → Solana USDG quote passed:", JSON.stringify({ amount: forward.dstAmount, fees: forward.fees }));
const simulationOwner = process.env.SOLANA_SIMULATION_OWNER;
if (!simulationOwner) {
  console.log("Reverse simulation skipped: set SOLANA_SIMULATION_OWNER to a funded public USDG holder (no private key).");
  process.exit(0);
}
const reverse = await buildDirectOftQuote({ ...common, srcChain: solChain, dstChain: evmChain, srcToken: solToken, dstToken: evmToken, from: simulationOwner, to: evmWallet, simulate: true });
assert.equal(reverse.dstAmount, "1000000");
const tx = VersionedTransaction.deserialize(Buffer.from(reverse.userSteps[0].transaction.encoded.serializedTransaction, "base64"));
assert.ok(tx.signatures.every((signature) => signature.every((byte) => byte === 0)));
console.log("Solana → Ethereum USDG quote and unsigned send simulation passed:", JSON.stringify({ amount: reverse.dstAmount, fees: reverse.fees, bytes: tx.serialize().length }));
// Verify the rent calculation against an actual Token-2022 ATA creation simulation.
const payer = new PublicKey(simulationOwner);
const mint = new PublicKey(solToken.address);
const ata = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_2022_PROGRAM_ID);
assert.equal(await connection.getAccountInfo(ata), null);
const mintRaw = await connection.getAccountInfo(mint);
const expectedSize = solanaOftTokenAccountSize(unpackMint(mint, mintRaw, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
const { blockhash } = await connection.getLatestBlockhash();
const createAta = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [
  createAssociatedTokenAccountIdempotentInstruction(payer, ata, recipient, mint, TOKEN_2022_PROGRAM_ID),
] }).compileToV0Message());
const simulated = await connection.simulateTransaction(createAta, { sigVerify: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: [ata.toBase58()] } });
assert.equal(simulated.value.err, null, JSON.stringify(simulated.value.logs));
assert.equal(Buffer.from(simulated.value.accounts[0].data[0], "base64").length, expectedSize);
assert.equal(simulated.value.accounts[0].lamports, await connection.getMinimumBalanceForRentExemption(expectedSize));
console.log(`USDG ATA creation simulation passed: ${expectedSize} bytes, ${simulated.value.accounts[0].lamports} lamports.`);
