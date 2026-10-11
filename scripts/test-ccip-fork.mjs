// Run a LOCAL Anvil fork and the local app first. Never submits to a public RPC.
// anvil --host 127.0.0.1 --port 18545 --fork-url https://eth.drpc.org
// npm run dev
// node scripts/test-ccip-fork.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import ts from "typescript";
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, encodeAbiParameters, toHex } from "viem";
import { mainnet } from "viem/chains";
const cjs = { exports: {} };
new Script(ts.transpileModule(readFileSync(new URL("../src/lib/ccip-execution.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({ module: cjs, exports: cjs.exports, require: createRequire(import.meta.url) });
const { executeCcipTransfer } = cjs.exports;
const transport = http("http://127.0.0.1:18545", { timeout: 60_000 });
const client = createPublicClient({ chain: mainnet, transport });
const nodeInfo = await client.request({ method: "anvil_nodeInfo" });
assert.ok(nodeInfo.forkConfig?.forkUrl, "must use a local Anvil fork");
assert.equal(await client.getChainId(), 1);
const wallet = createWalletClient({ chain: mainnet, transport });
const [sender] = await wallet.getAddresses();
const request = { provider: "ccip", srcChainKey: "ethereum", dstChainKey: "base", srcTokenAddress: "0x514910771af9ca656af840dff83e8264ecf986ca", dstTokenAddress: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196", dstWalletAddress: sender, amount: "1000000000000000000" };
const refresh = async () => {
  const response = await fetch("http://127.0.0.1:3000/api/bridge/quotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result.quotes[0];
};
const snapshot = await client.request({ method: "evm_snapshot" });
try {
  await client.request({ method: "anvil_setBalance", params: [sender, toHex(10n ** 20n)] });
  // Discover LINK's balance mapping in the local fork. Restore every nonmatching slot.
  let funded = false;
  const amount = 10n ** 19n;
  for (let index = 0; index < 12; index++) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [sender, BigInt(index)]));
    const old = await client.getStorageAt({ address: request.srcTokenAddress, slot });
    await client.request({ method: "anvil_setStorageAt", params: [request.srcTokenAddress, slot, toHex(amount, { size: 32 })] });
    if (await client.readContract({ address: request.srcTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [sender] }) === amount) { funded = true; break; }
    await client.request({ method: "anvil_setStorageAt", params: [request.srcTokenAddress, slot, old ?? toHex(0n, { size: 32 })] });
  }
  assert.ok(funded, "fund the test account with LINK on the local fork only");
  const quote = await refresh();
  const transactions = [];
  const hash = await executeCcipTransfer(quote, request, { chainType: "EVM", chainId: 1, chainKey: "ethereum" }, sender, {
    assertContext() {}, refresh,
    read: args => client.readContract(args),
    send: async (tx, kind) => {
      await client.call({ ...tx, account: sender });
      const hash = await wallet.sendTransaction({ ...tx, account: sender });
      transactions.push({ kind, hash });
      return hash;
    },
    wait: async hash => { const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); return receipt.transactionHash; },
    submitted() {}, step: text => console.log(text),
  });
  const receipt = await client.getTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  assert.ok(receipt.logs.some(log => log.address.toLowerCase() !== request.srcTokenAddress.toLowerCase()), "router/onramp emitted logs");
  assert.equal(await client.readContract({ address: request.srcTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [sender] }), amount - BigInt(request.amount));
  assert.equal(await client.readContract({ address: request.srcTokenAddress, abi: erc20Abi, functionName: "allowance", args: [sender, quote.ccip.router] }), 0n, "exact allowance was consumed");
  console.log(JSON.stringify({ result: "Local fork CCIP approval and send passed", transactions, logCount: receipt.logs.length }));
} finally {
  await client.request({ method: "evm_revert", params: [snapshot] });
}
