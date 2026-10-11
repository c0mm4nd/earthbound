// LOCAL Anvil only; no public signing/broadcasting. Run the app on :3000 and:
// anvil --host 127.0.0.1 --port 18545 --fork-url https://ethereum-rpc.publicnode.com
// CCIP_NATIVE_FORK_CHAIN=1 node scripts/test-ccip-native-fork.mjs
// Other chains use ports 18546 (OP), 18547 (Arbitrum), 18548 (Base).
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, parseAbi, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, toHex } from 'viem';
import { mainnet, optimism, arbitrum, base } from 'viem/chains';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { CCIP_NATIVE_NETWORKS: configs } = load('ccip-native');
const { executeCcipTransfer } = load('ccip-execution');
const id = Number(process.env.CCIP_NATIVE_FORK_CHAIN ?? 1);
const network = { 1: [mainnet, 'ethereum', 18545], 10: [optimism, 'optimism', 18546], 42161: [arbitrum, 'arbitrum', 18547], 8453: [base, 'base', 18548] };
assert.ok(network[id]);
const [chain, chainKey, port] = network[id], config = configs[id];
const transport = http(`http://127.0.0.1:${port}`, { timeout: 60_000 });
const client = createPublicClient({ chain, transport }), wallet = createWalletClient({ chain, transport });
assert.ok((await client.request({ method: 'anvil_nodeInfo' })).forkConfig?.forkUrl);
assert.equal(await client.getChainId(), id);
assert.equal(keccak256(await client.getCode({ address: config.wrapper })), config.codeHash);
const [sender] = await wallet.getAddresses();
const snapshot = await client.request({ method: 'evm_snapshot' });
const native = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const amount = 1000000000000000n;
const send = async tx => {
  await client.call({ ...tx, account: sender });
  const hash = await wallet.sendTransaction({ ...tx, account: sender });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success'); return receipt;
};
try {
  await client.request({ method: 'anvil_setBalance', params: [sender, toHex(1000n * 10n ** 18n)] });
  for (const [destinationId, [, destinationKey]] of Object.entries(network)) {
    if (Number(destinationId) === id) continue;
    const request = { provider: 'ccip', srcChainKey: chainKey, dstChainKey: destinationKey, srcTokenAddress: native,
      dstTokenAddress: native, srcWalletAddress: sender, dstWalletAddress: sender, amount: amount.toString() };
    const refresh = async () => {
      const response = await fetch('http://127.0.0.1:3000/api/bridge/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const result = await response.json(); assert.equal(response.status, 200, result.error); return result.quotes[0];
    };
    const quote = await refresh();
    const startingBalance = await client.getBalance({ address: sender });
    const submissions = [];
    let spent;
    const hash = await executeCcipTransfer(quote, request, { chainId: id, chainType: 'EVM', chainKey }, sender, {
      assertContext() {}, refresh, read: args => client.readContract(args),
      send: async (tx, kind) => { assert.equal(kind, 'bridge'); spent = tx.value; return (await send(tx)).transactionHash; },
      wait: async hash => hash, submitted: (hash, confirmed) => submissions.push({ hash, confirmed }), step() {},
    });
    const receipt = await client.getTransactionReceipt({ hash });
    const paid = startingBalance - await client.getBalance({ address: sender });
    assert.ok(paid >= spent + receipt.gasUsed * receipt.effectiveGasPrice);
    assert.ok(spent > amount); assert.equal(submissions.length, 2);
    assert.equal(await client.readContract({ address: config.wrappedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sender] }), 0n, 'no separate WETH balance/approval needed');
    assert.ok(receipt.logs.some(log => log.address.toLowerCase() === config.wrappedToken));
    console.log(`Native CCIP fork source ${chainKey} -> ${destinationKey}: atomic wrap/send passed (${receipt.logs.length} logs).`);
  }
  // Exercise the actual deployed destination callback with a router caller and
  // delivered WETH on the LOCAL fork. This does not emulate CCIP consensus.
  const receiveAbi = parseAbi(['struct TokenAmount { address token; uint256 amount; }',
    'struct Message { bytes32 messageId; uint64 sourceChainSelector; bytes sender; bytes data; TokenAmount[] destTokenAmounts; }',
    'function ccipReceive(Message message)']);
  const wethAbi = parseAbi(['function deposit() payable']);
  const recipient = '0x3333333333333333333333333333333333333333';
  for (const rejectsEth of [false, true]) {
    if (rejectsEth) await client.request({ method: 'anvil_setCode', params: [recipient, '0x60006000fd'] });
    await send({ to: config.wrappedToken, value: amount, data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }) });
    await send({ to: config.wrappedToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [config.wrapper, amount] }) });
    const beforeEth = await client.getBalance({ address: recipient });
    const beforeWeth = await client.readContract({ address: config.wrappedToken, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] });
    const foreign = Object.values(configs).find(c => c.selector !== config.selector);
    const message = { messageId: toHex(rejectsEth ? 2n : 1n, { size: 32 }), sourceChainSelector: BigInt(foreign.selector),
      sender: encodeAbiParameters([{ type: 'address' }], [foreign.wrapper]), data: encodeAbiParameters([{ type: 'address' }], [recipient]),
      destTokenAmounts: [{ token: config.wrappedToken, amount }] };
    const data = encodeFunctionData({ abi: receiveAbi, functionName: 'ccipReceive', args: [message] });
    await assert.rejects(client.call({ to: config.wrapper, data, account: sender }), 'only the configured router may deliver');
    await client.request({ method: 'anvil_impersonateAccount', params: [config.router] });
    await client.request({ method: 'anvil_setBalance', params: [config.router, toHex(10n ** 18n)] });
    // The CCIP callback budget excludes the outer transaction's intrinsic gas.
    const intrinsicGas = 21000n + data.slice(2).match(/../g).reduce((sum, byte) => sum + (byte === '00' ? 4n : 16n), 0n);
    const tx = await wallet.sendTransaction({ to: config.wrapper, data, account: config.router, gas: intrinsicGas + 100000n });
    const receipt = await client.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, 'success', 'callback execution fits the quoted 100000 gas');
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [config.router] });
    assert.equal((await client.getBalance({ address: recipient })) - beforeEth, rejectsEth ? 0n : amount);
    assert.equal((await client.readContract({ address: config.wrappedToken, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })) - beforeWeth, rejectsEth ? amount : 0n);
    console.log(`Native CCIP fork ${chainKey} receive: ${rejectsEth ? 'ETH rejection -> WETH fallback' : 'unwrap -> exact ETH receipt'} passed.`);
  }
} finally {
  await client.request({ method: 'anvil_stopImpersonatingAccount', params: [config.router] });
  await client.request({ method: 'evm_revert', params: [snapshot] });
}
