// LOCAL Anvil forks only. No public transaction signing or broadcasting.
// anvil --host 127.0.0.1 --port 19545 --fork-url https://ethereum-rpc.publicnode.com
// anvil --host 127.0.0.1 --port 19546 --fork-url https://mainnet.base.org
// node scripts/test-cctp-fork.mjs
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, erc20Abi, parseAbi, encodeFunctionData, encodeAbiParameters, keccak256, toHex } from 'viem';
import { mainnet, base } from 'viem/chains';
import { createLoader } from './helpers/load-ts.mjs';
import { attester } from './helpers/cctp-fixture.mjs';
const load = createLoader(), { cctpEvm, CCTP_ABI } = load('cctp-evm');
const { initiateCctpTransfer, monitorCctpTransfer, claimCctpTransfer } = load('cctp-lifecycle');
const { parseCctpMessage } = load('cctp-message');
const clients = [mainnet, base].map((chain, i) => {
  const transport = http(`http://127.0.0.1:${19545 + i}`, { timeout: 60_000 });
  return { public: createPublicClient({ chain, transport }), wallet: createWalletClient({ chain, transport }) };
});
for (const [index, c] of clients.entries()) {
  assert.ok((await c.public.request({ method: 'anvil_nodeInfo' })).forkConfig?.forkUrl, 'localhost must be Anvil fork');
  assert.equal(await c.public.getChainId(), [1, 8453][index]);
}
const snapshots = await Promise.all(clients.map(c => c.public.request({ method: 'evm_snapshot' })));
const [src, dst] = clients, source = cctpEvm(0), destination = cctpEvm(6);
const [sender] = await src.wallet.getAddresses();
const recipient = '0x2222222222222222222222222222222222222222';
try {
  for (const c of clients) await c.public.request({ method: 'anvil_setBalance', params: [sender, toHex(10n ** 20n)] });
  let funded = false;
  for (let index = 0; index < 24; index++) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender, BigInt(index)]));
    const old = await src.public.getStorageAt({ address: source.usdc, slot });
    await src.public.request({ method: 'anvil_setStorageAt', params: [source.usdc, slot, toHex(1000000000n, { size: 32 })] });
    if (await src.public.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [sender] }) === 1000000000n) { funded = true; break; }
    await src.public.request({ method: 'anvil_setStorageAt', params: [source.usdc, slot, old ?? toHex(0n, { size: 32 })] });
  }
  assert.ok(funded, 'fund USDC only in localhost state');
  let saved;
  const transfer = { sourceDomain: 0, destinationDomain: 6, sender, recipient, amount: '100000000', maxFee: '0', finality: 2000, state: 'preparing' };
  const txs = [];
  const burned = await initiateCctpTransfer(transfer, {
    source: src.public, destination: dst.public, assertContext() {}, refreshFee: async () => 0n,
    send: async (tx, kind) => {
      await src.public.call({ ...tx, account: sender });
      const hash = await src.wallet.sendTransaction({ ...tx, account: sender }); txs.push({ kind, hash }); return hash;
    },
    wait: hash => src.public.waitForTransactionReceipt({ hash }), persist: t => saved = t, step: console.log,
  });
  assert.equal(saved.state, 'attestation_pending');
  assert.equal(await src.public.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [sender] }), 900000000n);
  assert.equal(await src.public.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'allowance', args: [sender, source.messenger] }), 0n);
  assert.equal((await monitorCctpTransfer(burned, { source: src.public, destination: dst.public, messages: async () => ({ messages: [] }) })).transfer.state, 'attestation_pending');

  // Iris cannot attest a localhost burn. On the destination fork ONLY, enable a
  // public deterministic test attester and sign the emitted source message.
  // This exercises deployed verification/mint contracts, not Circle's service.
  const adminAbi = parseAbi(['function attesterManager() view returns(address)', 'function enableAttester(address)', 'function setSignatureThreshold(uint256)']);
  const manager = await dst.public.readContract({ address: destination.transmitter, abi: adminAbi, functionName: 'attesterManager' });
  await dst.public.request({ method: 'anvil_setBalance', params: [manager, toHex(10n ** 19n)] });
  await dst.public.request({ method: 'anvil_impersonateAccount', params: [manager] });
  for (const [functionName, args] of [['enableAttester', [attester.address]], ['setSignatureThreshold', [1n]]]) {
    const hash = await dst.wallet.sendTransaction({ account: manager, to: destination.transmitter, gas: 500000n, data: encodeFunctionData({ abi: adminAbi, functionName, args }) });
    await dst.public.request({ method: 'evm_mine' });
    assert.equal((await dst.public.waitForTransactionReceipt({ hash })).status, 'success');
  }
  await dst.public.request({ method: 'anvil_stopImpersonatingAccount', params: [manager] });
  const bytes = Buffer.from(burned.sourceMessage.slice(2), 'hex');
  Buffer.from(toHex(987654321n, { size: 32 }).slice(2), 'hex').copy(bytes, 12);
  bytes.writeUInt32BE(2000, 144);
  const message = '0x' + bytes.toString('hex');
  const attestation = await attester.sign({ hash: keccak256(message) });
  const messages = async () => ({ messages: [{ message, attestation, status: 'complete', cctpVersion: 2 }] });
  const ready = await monitorCctpTransfer(burned, { source: src.public, destination: dst.public, messages });
  assert.equal(ready.transfer.state, 'ready', 'attested is not yet minted');
  const before = await dst.public.readContract({ address: destination.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] });
  await claimCctpTransfer(ready.transfer, ready.proof, {
    destination: dst.public, account: sender, assertContext() {}, persist: t => saved = t,
    send: async tx => {
      const hash = await dst.wallet.sendTransaction({ ...tx, account: sender, gas: 1000000n });
      await dst.public.request({ method: 'evm_mine' });
      return hash;
    },
  });
  assert.equal(saved.state, 'claim_pending');
  assert.equal((await dst.public.waitForTransactionReceipt({ hash: saved.claimHash })).status, 'success');
  assert.equal(await dst.public.readContract({ address: destination.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }) - before, 100000000n);
  const complete = await monitorCctpTransfer(saved, { source: src.public, destination: dst.public, messages });
  assert.equal(complete.transfer.state, 'complete');
  assert.equal(await dst.public.readContract({ address: destination.transmitter, abi: CCTP_ABI, functionName: 'usedNonces', args: [parseCctpMessage(message).nonce] }), 1n);
  let replayed = false;
  await claimCctpTransfer(ready.transfer, ready.proof, { destination: dst.public, account: sender, assertContext() {}, persist: t => saved = t,
    send: async () => { replayed = true; throw Error('must not resend'); },
  });
  assert.equal(replayed, false);
  console.log(JSON.stringify({ result: 'Local Ethereum -> Base burn, monitor, claim, exact USDC receipt and replay guard passed', sourceTransactions: txs, claimHash: complete.transfer.claimHash }));
} finally {
  await Promise.all(clients.map((c, i) => c.public.request({ method: 'evm_revert', params: [snapshots[i]] })));
}
