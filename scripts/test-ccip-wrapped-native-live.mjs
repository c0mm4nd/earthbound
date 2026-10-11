// Read-only mainnet-state probes. Only eth_call / reads go to public RPCs.
// Requires forge on PATH and the local app on port 3000. No wallet or key.
// Select networks with CCIP_NATIVE_CHAINS=16661,964; defaults to every adapter.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, encodeFunctionData, keccak256, zeroAddress } from 'viem';
import { createLoader } from './helpers/load-ts.mjs';
const load = createLoader();
const { CCIP_WRAPPED_NATIVE: configs } = load('ccip-wrapped-native');
const { verifyCcipWrappedNative, verifyCcipNativeSource, CcipNativeSourcePausedError } = load('ccip-native-rpc');
const { CCIP_ROUTER_ABI, ccipMessage } = load('ccip-execution');
const project = mkdtempSync(join(tmpdir(), 'earthbound-native-probe-'));
const audit = '0x0000000000000000000000000000001234567890';
const dummy = '0x000000000000000000000000000000abcdef1234';
const recipient = '0x1111111111111111111111111111111111111111';
const amount = 10000000000000000n;
const native = a => /^0x(0{40}|e{40})$/i.test(a);
async function fundedSender(client, minimum) {
  // Frontier native balances live outside EVM account overrides. Reuse a
  // public funded sender only inside eth_call; never impersonate/broadcast.
  const latest = await client.getBlockNumber(), seen = new Set();
  for (let b = latest; b > latest - 40n; b--) {
    const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) {
      if (seen.has(tx.from)) continue;
      seen.add(tx.from);
      if (await client.getBalance({ address: tx.from }) > minimum + 10000000000000000n) return tx.from;
    }
  }
  throw Error('No funded public sender found for a read-only Frontier simulation.');
}
try {
  mkdirSync(join(project, 'src'));
  cpSync(new URL('./fixtures/native-conversion/', import.meta.url), join(project, 'src'), { recursive: true });
  execFileSync(process.env.FORGE_BIN ?? 'forge', ['build', '--root', project, '--use', '0.8.19'], { stdio: 'pipe' });
  const artifact = (file, name) => JSON.parse(readFileSync(join(project, 'out', file + '.sol', name + '.json')));
  const [chainResponse, tokenResponse] = await Promise.all(['chains', 'tokens'].map(async route => {
    const response = await fetch(`http://localhost:3000/api/bridge/${route}`);
    assert.ok(response.ok); return response.json();
  }));
  const selected = process.env.CCIP_NATIVE_CHAINS?.split(',').map(Number);
  for (const [id, config] of Object.entries(configs)) {
    const chainId = Number(id); if (selected && !selected.includes(chainId)) continue;
    await verifyCcipWrappedNative([chainId]);
    const chain = chainResponse.chains.find(c => c.chainType === 'EVM' && c.chainId === chainId);
    const token = tokenResponse.tokens.find(t => t.chainKey === chain?.chainKey && native(t.address) && t.ccip);
    assert.ok(token, `native ${config.symbol} catalog entry`);
    const dest = token.ccip.destinations.find(t => /^0x[0-9a-f]{40}$/i.test(t.address) && !native(t.address));
    assert.ok(dest, 'a real wrapped-token EVM destination');
    const response = await fetch('http://localhost:3000/api/bridge/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'ccip', srcChainKey: token.chainKey, srcTokenAddress: token.address, dstChainKey: dest.chainKey, dstTokenAddress: dest.address,
      srcWalletAddress: recipient, dstWalletAddress: recipient, amount: amount.toString(),
    }) });
    const result = await response.json();
    if (!response.ok && /temporarily paused/.test(result.error ?? "")) {
      const destChain = chainResponse.chains.find(c => c.chainKey === dest.chainKey);
      const selector = configs[destChain.chainId]?.selector;
      assert.ok(selector, "paused route destination selector fixture");
      await assert.rejects(verifyCcipNativeSource(chainId, selector), CcipNativeSourcePausedError);
      console.log(`${chainId} ${config.symbol}: live CCIP risk pause confirmed; native quote is blocked before wrapping.`);
      continue;
    }
    assert.ok(response.ok, result.error);
    const quote = result.quotes[0]; assert.equal(quote.ccip.wrapping.source.toLowerCase(), config.token.toLowerCase());
    const client = createPublicClient({ transport: http(config.rpc, { timeout: 25_000, retryCount: 1 }) });
    const fee = await client.readContract({ address: config.router, abi: CCIP_ROUTER_ABI, functionName: 'getFee', args: [BigInt(quote.ccip.destinationSelector), ccipMessage(quote)] });
    const frontier = [592,964].includes(chainId), sender = frontier ? await fundedSender(client, amount + fee) : dummy;
    const fundedOverride = frontier ? [] : [{ address: sender, balance: amount + fee + 100000000000000000000n }];
    const roundTrip = config.vault ? artifact('WrapAudit', 'TaoWrapAudit') : artifact('WrapAudit', 'WrapAudit');
    const check = await client.call({ account: sender, to: audit, value: amount, data: encodeFunctionData({ abi: roundTrip.abi, functionName: 'roundTrip', args: config.vault ? [config.vault.address, config.token] : [config.token] }),
      stateOverride: [{ address: audit, code: roundTrip.deployedBytecode.object }, ...fundedOverride] });
    assert.equal(BigInt(check.data), amount, 'wrap and unwrap preserve principal, token balances and native balance');
    const send = artifact('SendAudit', 'SendAudit');
    const sent = await client.call({ account: sender, to: audit, value: amount + fee, data: encodeFunctionData({ abi: send.abi, functionName: 'wrapAndSend', args: [config.token, config.vault?.address ?? zeroAddress, config.router, BigInt(quote.ccip.destinationSelector), recipient, amount] }),
      stateOverride: [{ address: audit, code: send.deployedBytecode.object }, ...fundedOverride] });
    assert.match(sent.data, /^0x[0-9a-f]{64}$/i);
    assert.notEqual(BigInt(sent.data), 0n);
    console.log(`${chainId} ${config.symbol}: deployment ${keccak256(await client.getCode({ address: config.token }))}; exact round trip and wrap/approve/CCIP source-send simulation passed.`);
  }
} finally { rmSync(project, { recursive: true, force: true }); }
