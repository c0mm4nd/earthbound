import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackMultisig } from "@solana/spl-token";
import { stringToBytes, toHex } from "viem";
import type { LayerZeroOftListResponse } from "./bridge-types";

// Discovery hints are never authorization: the adapter must still validate the
// store PDA, mint, program and both peers before any quote or transaction.
export async function discoverSolanaOftStores(rpcUrl: string, mintAddress: string, metadata: LayerZeroOftListResponse): Promise<string[]> {
  const connection = new Connection(rpcUrl, "confirmed"), mintKey = new PublicKey(mintAddress);
  const mintRaw = await connection.getAccountInfo(mintKey);
  if (!mintRaw || (!mintRaw.owner.equals(TOKEN_PROGRAM_ID) && !mintRaw.owner.equals(TOKEN_2022_PROGRAM_ID))) return [];
  const mint = unpackMint(mintKey, mintRaw, mintRaw.owner);
  if (!mint.isInitialized) return [];
  const candidates = new Set<string>();
  for (const entry of Object.values(metadata).flat()) {
    const deployment = entry.deployments?.solana;
    if (entry.endpointVersion?.toLowerCase() !== "v2" || !deployment ||
      (deployment.innerTokenAddress || deployment.address) !== mintAddress) continue;
    if (deployment.details?.oftPDA) candidates.add(deployment.details.oftPDA);
    if (deployment.details?.mintAuthority) candidates.add(deployment.details.mintAuthority);
    const { oftProgramId, escrowTokenAccount } = deployment.details ?? {};
    if (oftProgramId && escrowTokenAccount) {
      try {
        for (const prefix of ["OFT", "Oft"]) candidates.add(PublicKey.findProgramAddressSync(
          [stringToBytes(prefix), new PublicKey(escrowTokenAccount).toBytes()], new PublicKey(oftProgramId),
        )[0].toBase58());
      } catch { /* Malformed metadata never bypasses on-chain validation. */ }
    }
  }
  if (mint.mintAuthority) {
    const raw = await connection.getAccountInfo(mint.mintAuthority);
    if (raw?.owner.equals(mintRaw.owner)) {
      const authority = unpackMultisig(mint.mintAuthority, raw, mintRaw.owner);
      if (authority.isInitialized && authority.n >= 1 && authority.n <= 11) {
        [authority.signer1, authority.signer2, authority.signer3, authority.signer4, authority.signer5,
          authority.signer6, authority.signer7, authority.signer8, authority.signer9, authority.signer10, authority.signer11]
          .slice(0, authority.n).forEach((key) => candidates.add(key.toBase58()));
      }
    } else candidates.add(mint.mintAuthority.toBase58());
  }
  const keys = [...candidates].slice(0, 32).flatMap((key) => {
    try { return [new PublicKey(key)]; } catch { return []; }
  });
  if (!keys.length) return [];
  const accounts = await connection.getMultipleAccountsInfo(keys);
  return keys.filter((_, index) => {
    const raw = accounts[index];
    return raw && !raw.executable && ["0xc3d76886b9c3f072", "0x32615980630f6b1b"].includes(toHex(raw.data.subarray(0, 8)));
  }).map((key) => key.toBase58());
}
