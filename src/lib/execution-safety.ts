import { isAddress } from "viem";
import type { BridgeChain, QuoteUserStep, SignatureUserStep, TransactionUserStep } from "./bridge-types";

export function assertSuccessfulEvmReceipt(receipt: { status?: unknown }) {
  if (receipt.status !== "success" && receipt.status !== "0x1")
    throw new Error("EVM transaction reverted or has no successful receipt. Execution stopped.");
}

// Validate the entire plan before any approval or signature is requested.
export function assertExecutionPlan(steps: QuoteUserStep[], chain: BridgeChain, sender: string) {
  if (!steps.length) throw new Error("No executable steps returned for this quote.");
  for (const step of steps) {
    if (!step || step.chainType !== chain.chainType || step.chainKey !== chain.chainKey)
      throw new Error("Execution step does not match the selected source chain.");
    const signer = (step as unknown as { signerAddress?: string }).signerAddress;
    const matches = (value: string) => chain.chainType === "EVM"
      ? value.toLowerCase() === sender.toLowerCase() : value === sender;
    if (signer && !matches(signer)) throw new Error("Execution signer does not match the connected wallet.");
    if (step.type === "SIGNATURE" && chain.chainType === "EVM") {
      const typed = (step as SignatureUserStep).signature?.typedData;
      if (!typed?.primaryType || !typed.types || Number(typed.domain?.chainId) !== chain.chainId ||
        typeof typed.domain?.verifyingContract !== "string" || !isAddress(typed.domain.verifyingContract))
        throw new Error("Invalid signature domain or chain. Execution stopped.");
    } else if (step.type === "TRANSACTION") {
      const tx = (step as TransactionUserStep).transaction?.encoded;
      if (!tx || typeof tx !== "object") throw new Error("Missing transaction payload.");
      if (chain.chainType === "EVM") {
        if (!tx.to || !isAddress(tx.to) || /^0x0{40}$/i.test(tx.to) ||
          (tx.data !== undefined && !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data)) ||
          (tx.chainId !== undefined && Number(tx.chainId) !== chain.chainId) ||
          (tx.from !== undefined && (typeof tx.from !== "string" || !matches(tx.from))))
          throw new Error("Invalid EVM transaction target, sender, calldata or chain.");
        for (const value of [tx.value, tx.gasLimit]) {
          if (value !== undefined && (!/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(value) || BigInt(value) >= BigInt(2) ** BigInt(256)))
            throw new Error("Invalid EVM transaction value or gas limit.");
        }
      }
    } else {
      throw new Error(`Unsupported execution step: ${step.type}.`);
    }
  }
}
