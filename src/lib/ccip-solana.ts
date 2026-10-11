import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { TransactionUserStep } from "./bridge-types";
import { isCcipAddress } from "./ccip-addresses";
import type { CcipChain, CcipQuoteRequest } from "./ccip";

// Server-only entrypoint: the official builder derives router accounts and exact
// approvals from our validated transfer, rather than signing third-party calldata.
export async function buildCcipSolanaStep(source: CcipChain, destination: CcipChain, request: CcipQuoteRequest, fee: bigint): Promise<TransactionUserStep> {
  if (source.chainType !== "SOLANA" || !isCcipAddress("SOLANA", request.srcWalletAddress ?? "")) throw new Error("Connect a Solana source wallet.");
  const { generateUnsignedCcipSend } = await import("@chainlink/ccip-sdk/dist/solana/send.js");
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://solana-rpc.publicnode.com", "confirmed");
  if (await connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("CCIP Solana RPC network mismatch.");
  // Use the same v1.6 entrypoint/extraArgs as the HTTP fee quote. Do not silently
  // upgrade to v2 here: its pool deductions and execution policy may differ.
  const unsigned = await generateUnsignedCcipSend({ connection }, new PublicKey(request.srcWalletAddress!), new PublicKey(source.ccip.router),
    BigInt(destination.ccip.selector!), { receiver: request.dstWalletAddress,
      tokenAmounts: [{ token: request.srcTokenAddress, amount: BigInt(request.amount) }], fee,
      extraArgs: { gasLimit: BigInt(0), allowOutOfOrderExecution: true } }, { approveMax: false });
  const validity = await connection.getLatestBlockhash("confirmed");
  const instructions = unsigned.instructions;
  if (!instructions.some(ix => ix.programId.toBase58() === source.ccip.router)) throw new Error("CCIP builder returned no router instruction.");
  // Keep approval and bridge atomic. A rejected/expired transaction cannot leave
  // a separate approval submitted and cannot masquerade as a CCIP source send.
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(request.srcWalletAddress!), recentBlockhash: validity.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
  }).compileToV0Message(unsigned.lookupTables));
  const serialized = transaction.serialize();
  if (serialized.length > 1232) throw new Error("This CCIP transaction exceeds the wallet transaction size limit.");
  return { type: "TRANSACTION", chainType: "SOLANA", chainKey: source.chainKey, description: "Send CCIP transfer",
    transaction: { encoded: { encoding: "base64", serializedTransaction: Buffer.from(serialized).toString("base64"), ...validity, ccip: true } } };
}
