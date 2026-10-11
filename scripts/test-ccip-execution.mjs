import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { decodeFunctionData, decodeAbiParameters, erc20Abi, zeroAddress } from "viem";

const require = createRequire(import.meta.url);
function load(name) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const cjs = { exports: {} };
  new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
    module: cjs, exports: cjs.exports, require, URLSearchParams, AbortSignal,
  });
  return cjs.exports;
}
const { executeCcipTransfer, CCIP_ROUTER_ABI, CCIP_EXTRA_ARGS, ccipTransactionValue } = load("ccip-execution");
const { ccipStatusQuery, normalizeCcipStatus } = load("ccip-status");
const address = n => `0x${n.toString(16).padStart(40, "0")}`;
const hash = n => `0x${n.toString(16).padStart(64, "0")}`;
const request = { srcChainKey: "ethereum", dstChainKey: "base", srcTokenAddress: address(1), dstTokenAddress: address(2), dstWalletAddress: address(3), amount: "100" };
const chain = { chainId: 1, chainKey: "ethereum", chainType: "EVM" };
const quote = {
  id: "ccip:1:2:123", provider: "ccip", srcAmount: "100", dstAmount: "99", userSteps: [],
  routeSteps: [{ type: "CCIP", srcChainKey: "ethereum", dstChainKey: "base" }],
  ccip: { router: address(4), sourceSelector: "1", destinationSelector: "2", sourceChainId: 1, sourceToken: address(1), destinationToken: address(2), receiver: address(3), nativeFee: "1000", maxNativeFee: "1010", quotedAt: Date.now() },
};
function harness(options = {}) {
  let allowance = options.allowance ?? 0n;
  let refreshes = 0;
  let sent = 0;
  const events = [];
  return { events, deps: {
    assertContext: () => { if (options.changedAfterApproval && sent) throw Error("context changed"); },
    refresh: async () => { refreshes++; events.push(["refresh"]); return options.refresh?.(refreshes) ?? structuredClone(quote); },
    read: async args => {
      events.push(["read", args.functionName]);
      if (args.functionName === "allowance") {
        assert.equal(args.address, request.srcTokenAddress);
        assert.equal(args.args[1], quote.ccip.router);
        return allowance;
      }
      assert.equal(args.functionName, "getFee");
      return options.fee ?? 999n;
    },
    send: async (tx, kind) => {
      sent++;
      events.push(["send", kind, tx]);
      if (options.reject) throw Error("wallet rejected");
      if (kind === "approval") {
        assert.equal(tx.to, request.srcTokenAddress);
        assert.equal(tx.value, 0n);
        const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        assert.equal(decoded.functionName, "approve");
        assert.equal(decoded.args[0], quote.ccip.router);
        if (!options.brokenApproval) allowance = decoded.args[1];
      } else {
        assert.equal(tx.to, quote.ccip.router);
        assert.equal(tx.value, 999n, "send exact current fee, not fee ceiling");
        const decoded = decodeFunctionData({ abi: CCIP_ROUTER_ABI, data: tx.data });
        assert.equal(decoded.functionName, "ccipSend");
        assert.equal(decoded.args[0], 2n);
        const message = decoded.args[1];
        assert.equal(decodeAbiParameters([{ type: "address" }], message.receiver)[0], request.dstWalletAddress);
        assert.equal(message.tokenAmounts.length, 1);
        assert.equal(message.tokenAmounts[0].token, request.srcTokenAddress);
        assert.equal(message.tokenAmounts[0].amount, 100n);
        assert.equal(message.feeToken, zeroAddress);
        assert.equal(message.data, "0x");
        assert.equal(message.extraArgs, CCIP_EXTRA_ARGS);
        assert.equal(message.extraArgs.slice(0, 10), "0x181dcf10");
        assert.deepEqual(decodeAbiParameters([{ type: "uint256" }, { type: "bool" }], `0x${message.extraArgs.slice(10)}`), [0n, true]);
      }
      return hash(sent);
    },
    wait: async (txHash, kind) => { events.push(["wait", kind]); if (kind === "bridge" && options.timeout) throw Error("receipt timeout"); return txHash; },
    submitted: (hash, confirmed) => events.push(["submitted", hash, confirmed]),
    step: description => events.push(["step", description]),
  } };
}
for (const allowance of [0n, 30n, 100n, 999n]) {
  const h = harness({ allowance });
  await executeCcipTransfer(quote, request, chain, address(5), h.deps);
  const approvals = h.events.filter(e => e[0] === "send" && e[1] === "approval");
  assert.equal(approvals.length, allowance === 0n ? 1 : allowance < 100n ? 2 : 0);
  assert.equal(h.events.filter(e => e[0] === "refresh").length, 2);
  assert.equal(h.events.filter(e => e[0] === "send" && e[1] === "bridge").length, 1);
  assert.equal(h.events.at(-1)[2], true);
}
for (const change of [
  q => { q.ccip.router = address(9); },
  q => { q.ccip.destinationSelector = "3"; },
  q => { q.ccip.sourceSelector = "3"; },
  q => { q.ccip.receiver = address(9); },
  q => { q.ccip.sourceToken = address(9); },
  q => { q.ccip.destinationToken = address(9); },
  q => { q.srcAmount = "200"; },
  q => { q.dstAmount = "98"; },
  q => { q.ccip.nativeFee = "1100"; q.ccip.maxNativeFee = "1111"; },
  q => { q.ccip.quotedAt = Date.now() - 200_000; },
  q => { q.ccip.sourceChainId = 10; },
  q => { q.routeSteps[0].dstChainKey = "evil"; },
]) {
  const fresh = structuredClone(quote); change(fresh);
  const h = harness({ refresh: () => fresh });
  await assert.rejects(executeCcipTransfer(quote, request, chain, address(5), h.deps));
  assert.equal(h.events.some(e => e[0] === "send"), false, "changed quote must stop before any approval");
}
for (const options of [{ fee: 1011n }, { changedAfterApproval: true }, { brokenApproval: true }, { reject: true }, {
  refresh: count => count === 1 ? structuredClone(quote) : { ...quote, dstAmount: "98" },
}]) {
  const h = harness(options);
  await assert.rejects(executeCcipTransfer(quote, request, chain, address(5), h.deps));
  assert.equal(h.events.some(e => e[0] === "send" && e[1] === "bridge"), false);
}
const timedOut = harness({ timeout: true });
await assert.rejects(executeCcipTransfer(quote, request, chain, address(5), timedOut.deps), /receipt timeout/);
assert.ok(timedOut.events.some(e => e[0] === "submitted" && e[2] === false), "record bridge hash before waiting for confirmation");

const query = ccipStatusQuery(quote.id, hash(4));
const message = { messageId: hash(7), sendTransactionHash: hash(4), sourceNetworkInfo: { chainSelector: "1" }, destNetworkInfo: { chainSelector: "2" }, status: "SUCCESS" };
assert.equal(normalizeCcipStatus({ data: [message] }, query).status, "COMPLETED");
assert.equal(normalizeCcipStatus({ data: [] }, query).status, "PENDING");
assert.equal(normalizeCcipStatus({ data: [{ ...message, sendTransactionHash: hash(8) }] }, query).status, "PENDING");
assert.equal(normalizeCcipStatus({ data: [{ ...message, destNetworkInfo: { chainSelector: "3" } }] }, query).status, "PENDING");
for (const status of ["SENT", "COMMITTED", "UNKNOWN", "UNRECOGNIZED"]) assert.equal(normalizeCcipStatus({ data: [{ ...message, status }] }, query).status, "PENDING");
assert.equal(normalizeCcipStatus({ data: [{ ...message, status: "FAILED" }] }, query).status, "ACTION_REQUIRED");
assert.equal(normalizeCcipStatus({ data: [{ ...message, status: "SENT", readyForManualExecution: true }] }, query).status, "ACTION_REQUIRED");
assert.throws(() => normalizeCcipStatus({ data: [message, message] }, query), /Multiple/);
assert.throws(() => ccipStatusQuery("ccip:garbage", hash(4)));
assert.throws(() => ccipStatusQuery(quote.id, "not-a-hash"));
assert.throws(() => normalizeCcipStatus({}, query));
console.log("CCIP execution: exact/reset approvals, local calldata, fresh fee checks, transfer binding, wallet changes, rejection, receipt timeout and destination status passed.");

assert.equal(ccipTransactionValue(295, 123n), 1230000000000n);
assert.equal(ccipTransactionValue(1, 123n), 123n);
assert.throws(() => ccipTransactionValue(295, 2n ** 256n));
