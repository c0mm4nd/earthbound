// Start an isolated Ethereum fork on 127.0.0.1:19659 before running this test.
// Transactions are sent only to Anvil; the public RPC receives fork reads only.
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, http } from "viem";
import { mainnet } from "viem/chains";

const transport = http("http://127.0.0.1:19659", { retryCount: 0 });
const client = createPublicClient({ transport, chain: mainnet });
assert.match(await client.request({ method: "web3_clientVersion" }), /anvil/i);
assert.equal(await client.getChainId(), 1);
const usde = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3";
const owner = "0x0000000000000000000000000000000000000005";
const spender = "0x0000000000000000000000000000000000000006";
const wallet = createWalletClient({ transport, chain: mainnet, account: owner });
const snapshot = await client.request({ method: "evm_snapshot" });
try {
  await client.request({ method: "anvil_impersonateAccount", params: [owner] });
  await client.request({ method: "anvil_setBalance", params: [owner, "0xde0b6b3a7640000"] });
  assert.ok((await client.getCode({ address: usde }))?.length > 2, "real USDe runtime must exist");
  const debit = 44291571655000000000000n;
  // Each approval replaces an existing allowance without an intervening zero.
  for (const amount of [1n, debit, debit - 1n, debit + 1n]) {
    const { request } = await client.simulateContract({ address: usde, abi: erc20Abi,
      functionName: "approve", args: [spender, amount], account: owner });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const approvals = receipt.logs.filter(log => log.address.toLowerCase() === usde)
      .map(log => decodeEventLog({ abi: erc20Abi, ...log }))
      .filter(log => log.eventName === "Approval");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].args.value, amount);
    assert.equal(await client.readContract({ address: usde, abi: erc20Abi,
      functionName: "allowance", args: [owner, spender] }), amount);
  }
  console.log("USDe mainnet fork: nonzero allowance replacement and exact approval amounts passed; no revoke, public signing or broadcast.");
} finally {
  assert.equal(await client.request({ method: "evm_revert", params: [snapshot] }), true);
}
