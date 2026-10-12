// Server-only orchestration. No private keys or broadcasts; wallets sign locally.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { createPublicClient, http, encodeFunctionData, erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { cctpNetwork } from "./cctp";
import { cctpApi } from "./cctp-api";
import { CCTP_ABI, cctpEvm, cctpSourceMessage } from "./cctp-evm";
import { CCTP_CHAINS } from "./cctp-catalog";
import { cctpAttesters } from "./cctp-message";
import { nativeCctpBurnArgs, isCctpNativeHash } from "./cctp-native";
import { assertCctpNativeMessage, cctpWireMessenger, type CctpNativeProof } from "./cctp-native-proof";
import { assertCctpNativeTransfer, monitorNativeCctp, type CctpNativeMonitor, type CctpNativeTransfer } from "./cctp-native-lifecycle";
import { buildCctpSolanaBurn, buildCctpSolanaClaim, readCctpSolanaAttesters, readCctpSolanaBurn, readCctpSolanaNonce } from "./cctp-solana";
import { createCctpMoveMonitor } from "./cctp-move-monitor";
import { createCctpStarknetMonitor } from "./cctp-starknet-monitor";
import { createCctpStellarMonitor } from "./cctp-stellar-monitor";
import { viemChainById } from "./viem-chains-by-id";
import type { TransactionPayload, TransactionUserStep } from "./bridge-types";

const solana = () => new Connection("https://solana-rpc.publicnode.com", "confirmed");
const evm = (domain: number) => createPublicClient({ chain: viemChainById[cctpEvm(domain).chainId], transport: http(undefined, { timeout: 15_000 }) });
export function nativeCctpStep(domain: number, encoded: TransactionPayload): TransactionUserStep {
  const c = CCTP_CHAINS.find(c => c.domain === domain)!;
  return { type: "TRANSACTION", chainType: c.family, chainKey: c.chainKey, transaction: { encoded: { ...encoded, cctp: true } } };
}
async function evmIdentity(domain: number, remote: number) {
  const c = cctpEvm(domain), client = evm(domain);
  const [id, local, remoteMessenger, paused, transmitter] = await Promise.all([
    client.getChainId(), client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "localDomain" }),
    client.readContract({ address: c.messenger, abi: CCTP_ABI, functionName: "remoteTokenMessengers", args: [remote] }),
    client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "paused" }),
    client.readContract({ address: c.messenger, abi: CCTP_ABI, functionName: "localMessageTransmitter" }),
  ]);
  if (id !== c.chainId || local !== domain || paused || transmitter.toLowerCase() !== c.transmitter || remoteMessenger.toLowerCase() !== cctpWireMessenger(remote)) throw new Error("CCTP mainnet deployment is unavailable.");
  return { c, client };
}
export function nativeCctpReader(domain: number, remote: number, t?: CctpNativeTransfer) {
  if (domain === 8 || domain === 9) return createCctpMoveMonitor(domain);
  if (domain === 25) return createCctpStarknetMonitor();
  if (domain === 27) return createCctpStellarMonitor();
  if (domain === 5) return {
    attesters: () => readCctpSolanaAttesters(solana()), nonceUsed: (nonce: Hex) => readCctpSolanaNonce(solana(), nonce),
    async receipt(hash: string, includeMessage = false) {
      if (!isCctpNativeHash(5, hash)) throw new Error("Invalid Solana signature.");
      if (includeMessage) {
        if (!t?.eventAccount) throw new Error("The saved Solana message account is needed to recover this burn.");
        return readCctpSolanaBurn(solana(), t, hash, t.eventAccount);
      }
      await readCctpSolanaAttesters(solana());
      const result = await solana().getSignatureStatus(hash, { searchTransactionHistory: true });
      return { state: result.value?.err ? "failed" as const : ["confirmed", "finalized"].includes(result.value?.confirmationStatus ?? "") ? "confirmed" as const : "pending" as const };
    },
  };
  return {
    async receipt(hash: string, includeMessage = false) {
      if (!isCctpNativeHash(domain, hash)) throw new Error("Invalid EVM transaction hash.");
      const { client } = await evmIdentity(domain, remote);
      try {
        const receipt = await client.getTransactionReceipt({ hash: hash as Hex });
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("CCTP receipt hash mismatch.");
        if (receipt.status === "reverted") return { state: "failed" as const };
        return { state: "confirmed" as const, ...(includeMessage ? { message: cctpSourceMessage(receipt, t!) } : {}) };
      } catch (error) {
        if (error instanceof Error && /TransactionReceiptNotFoundError/.test(error.name)) return { state: "pending" as const };
        throw error;
      }
    },
    async attesters(proof?: CctpNativeProof) {
      const { c, client } = await evmIdentity(domain, remote);
      const threshold = Number(await client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "signatureThreshold" }));
      // EVM can validate the actual signers without enumerating the set.
      const signers = proof ? await cctpAttesters(proof.message, proof.attestation) : [];
      const enabled = await Promise.all(signers.map(attester => client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "isEnabledAttester", args: [attester as Address] })));
      return { domain, threshold, enabledAttesters: signers.filter((_, i) => enabled[i]) };
    },
    async nonceUsed(nonce: Hex) {
      const { c, client } = await evmIdentity(domain, remote);
      return await client.readContract({ address: c.transmitter, abi: CCTP_ABI, functionName: "usedNonces", args: [nonce] }) !== BigInt(0);
    },
  };
}
export async function nativeCircleProof(t: CctpNativeTransfer): Promise<CctpNativeProof | null> {
  if (!t.burnHash || !t.sourceMessage) throw new Error("Verify the source burn before loading a Circle proof.");
  const response = await fetch(`https://iris-api.circle.com/v2/messages/${t.sourceDomain}?transactionHash=${encodeURIComponent(t.burnHash)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Circle proof service is unavailable.");
  const data = await response.json();
  if (!Array.isArray(data.messages)) throw new Error("Invalid Circle proof response.");
  const matches: CctpNativeProof[] = [];
  for (const row of data.messages) {
    if (row.status !== "complete" || row.cctpVersion !== 2) continue;
    try { assertCctpNativeMessage(t, row.message, true); matches.push({ message: row.message, attestation: row.attestation }); } catch { /* Other messages are not this burn. */ }
  }
  if (matches.length > 1) throw new Error("Circle returned multiple matching messages.");
  return matches[0] ?? null;
}
export function nativeCctpMonitor(t: CctpNativeTransfer): CctpNativeMonitor {
  const source = nativeCctpReader(t.sourceDomain, t.destinationDomain, t), destination = nativeCctpReader(t.destinationDomain, t.sourceDomain);
  let proof: CctpNativeProof | null = null;
  return {
    sourceReceipt: transfer => source.receipt(transfer.burnHash!, true),
    circleProof: async transfer => (proof = await nativeCircleProof(transfer)),
    destinationAttesters: () => destination.attesters(proof ?? undefined),
    nonceUsed: nonce => destination.nonceUsed(nonce), claimReceipt: async hash => (await destination.receipt(hash)).state,
  };
}
async function currentFee(t: CctpNativeTransfer) {
  const source = cctpNetwork(t.sourceDomain), destination = cctpNetwork(t.destinationDomain);
  const quotes = await cctpApi.estimate({ sourceDomain: t.sourceDomain, destinationDomain: t.destinationDomain, sourceToken: source.usdc, destinationToken: destination.usdc, amount: formatUnits(BigInt(t.amount), 6) });
  const quote = quotes.quotes.find(q => q.finalityThreshold === t.finality);
  if (!quote || BigInt(quote.protocolFee) > BigInt(t.maxFee)) throw new Error("CCTP fees changed. Request a new quote.");
  if (t.finality === 1000) {
    const response = await fetch("https://iris-api.circle.com/v2/fastBurn/USDC/allowance", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const { cctpUnits } = await import("./cctp");
    if (!response.ok || cctpUnits(String((await response.json()).allowance), 6) < BigInt(t.amount)) throw new Error("Circle Fast capacity is temporarily unavailable.");
  }
}
async function simulateSolana(step: TransactionUserStep) {
  const tx = VersionedTransaction.deserialize(Buffer.from(step.transaction.encoded.serializedTransaction!, "base64"));
  const result = await solana().simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (result.value.err) throw new Error(`Solana CCTP simulation failed: ${JSON.stringify(result.value.err)}`);
}
export type CctpNativePlan = { transfer: CctpNativeTransfer; step?: TransactionUserStep; prerequisite?: boolean };
export async function prepareNativeCctp(t: CctpNativeTransfer, action: "prepare" | "burn" | "claim", payer: string): Promise<CctpNativePlan> {
  assertCctpNativeTransfer(t);
  const claim = action === "claim", domain = claim ? t.destinationDomain : t.sourceDomain;
  const network = cctpNetwork(domain);
  const { normalizeCctpRecipient } = await import("./cctp-recipients");
  payer = normalizeCctpRecipient(network.family, payer);
  let proof: CctpNativeProof | undefined;
  if (claim) {
    const result = await monitorNativeCctp(t, nativeCctpMonitor(t)); t = result.transfer; proof = result.proof;
    if (t.state === "complete") return { transfer: t };
    if (t.state !== "ready" || !proof) throw new Error("CCTP claim is not ready or needs recovery.");
  } else {
    if (t.state !== "preparing" || t.burnHash || normalizeCctpRecipient(network.family, t.sender) !== payer) throw new Error("CCTP burn wallet changed or this transfer needs recovery.");
    await currentFee(t);
    await Promise.all([nativeCctpReader(t.sourceDomain, t.destinationDomain).attesters(), nativeCctpReader(t.destinationDomain, t.sourceDomain).attesters()]);
  }
  if (network.family === "EVM") {
    const { c, client } = await evmIdentity(domain, claim ? t.sourceDomain : t.destinationDomain);
    let to: Address = c.transmitter, data: Hex, prerequisite = false;
    if (proof) data = encodeFunctionData({ abi: CCTP_ABI, functionName: "receiveMessage", args: [proof.message, proof.attestation] });
    else {
      const args = nativeCctpBurnArgs(t, domain), amount = BigInt(t.amount);
      const allowance = await client.readContract({ address: c.usdc as Address, abi: erc20Abi, functionName: "allowance", args: [payer as Address, c.messenger] });
      if (allowance < amount) {
        if (action === "burn") throw new Error("Confirm the USDC approval first.");
        to = c.usdc as Address; prerequisite = true;
        data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.messenger, allowance > BigInt(0) ? BigInt(0) : amount] });
      } else {
        to = c.messenger;
        const base = [amount, t.destinationDomain, args.mintRecipient, c.usdc as Address, args.destinationCaller, BigInt(t.maxFee), t.finality] as const;
        data = args.hook === "0x" ? encodeFunctionData({ abi: CCTP_ABI, functionName: "depositForBurn", args: base }) : encodeFunctionData({ abi: CCTP_ABI, functionName: "depositForBurnWithHook", args: [...base, args.hook] });
      }
    }
    await client.call({ account: payer as Address, to, data, value: BigInt(0) });
    return { transfer: t, prerequisite, step: nativeCctpStep(domain, { to, data, value: "0" }) };
  }
  if (domain === 5) {
    if (!proof) {
      const built = await buildCctpSolanaBurn(solana(), t); await simulateSolana(built.step);
      return { transfer: { ...t, eventAccount: built.eventAccount }, step: built.step };
    }
    const built = await buildCctpSolanaClaim(solana(), t.recipient, payer, proof.message, proof.attestation);
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token"), { PublicKey } = await import("@solana/web3.js");
    const ata = getAssociatedTokenAddressSync(new PublicKey(network.usdc), new PublicKey(t.recipient), true);
    const prerequisite = !(await solana().getAccountInfo(ata, "confirmed"));
    const step = prerequisite ? built.prepare : built.claim; await simulateSolana(step);
    return { transfer: t, step, prerequisite };
  }
  if (domain === 9) {
    const { cctpAptosBurnPayload, cctpAptosClaimPayload } = await import("./cctp-aptos");
    const payload = proof ? cctpAptosClaimPayload(t.recipient, proof.message, proof.attestation) : cctpAptosBurnPayload(t);
    return { transfer: t, step: nativeCctpStep(domain, { cctpScript: payload.bcsToHex().toString() }) };
  }
  if (domain === 8) {
    const { prepareCctpSuiTransaction } = await import("./cctp-sui-service");
    return { transfer: t, step: nativeCctpStep(domain, { serializedTransaction: await prepareCctpSuiTransaction(t, payer, proof) }) };
  }
  if (domain === 25) {
    const { cctpStarknetBurnCalls, cctpStarknetClaimCall } = await import("./cctp-starknet");
    return { transfer: t, step: nativeCctpStep(domain, { calls: proof ? [cctpStarknetClaimCall(t.recipient, proof.message, proof.attestation)] : cctpStarknetBurnCalls(t) }) };
  }
  const { prepareCctpStellarTransaction } = await import("./cctp-stellar-service");
  return { transfer: t, prerequisite: action === "prepare", step: nativeCctpStep(domain, { serializedTransaction: await prepareCctpStellarTransaction(t, payer, action, proof) }) };
}
