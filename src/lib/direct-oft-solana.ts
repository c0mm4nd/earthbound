import { DEFAULT_RPC_URLS } from "./rpc-config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft, OftPDA } from "@layerzerolabs/oft-v2-solana-sdk";
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getExtensionTypes,
  getAssociatedTokenAddressSync,
  getAccountLen,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";
import { hexToBytes, toHex, type Hex } from "viem";
import type { BridgeToken, LayerZeroOftListDeployment } from "./bridge-types";
import type { DirectOftAdapter } from "./direct-oft-types";
import {
  buildLayerZeroExecutorLzReceiveOption,
  type LayerZeroOftV2SendParam,
} from "./custom-oft";

// Official LayerZero mainnet lookup table from the oft-solana integration example.
export const SOLANA_OFT_LOOKUP_TABLE =
  "AokBxha6VMLLgf97B5VYHEtqztamWmYERBmmFvjuTzJB";
const STORE_DISCRIMINATOR = "0xc3d76886b9c3f072";
const PEER_DISCRIMINATOR = "0xb59d56c621c15ecb";

export function receiveOptionValue(options: Hex): bigint {
  const bytes = hexToBytes(options);
  if (bytes.length < 2 || bytes[0] !== 0 || bytes[1] !== 3)
    throw new Error("Invalid enforced options.");
  let value = BigInt(0);
  for (let i = 2; i < bytes.length; ) {
    if (i + 3 > bytes.length) throw new Error("Truncated enforced options.");
    const worker = bytes[i];
    const size = bytes[i + 1] * 256 + bytes[i + 2];
    const start = i + 3;
    if (!size || start + size > bytes.length)
      throw new Error("Truncated enforced options.");
    if (worker === 1 && bytes[start] === 1 && size === 33) {
      value += BigInt(toHex(bytes.slice(start + 17, start + 33)));
    }
    i = start + size;
  }
  return value;
}

export function solanaRentExtraOptions(rent: bigint, enforced: Hex): Hex {
  const supplied = receiveOptionValue(enforced);
  return rent > supplied
    ? buildLayerZeroExecutorLzReceiveOption(BigInt(0), rent - supplied)
    : "0x";
}

function base64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export async function createSolanaOftAdapter(args: {
  rpcUrl?: string;
  storeAddress: string;
  deployment: LayerZeroOftListDeployment;
  token: BridgeToken;
  remoteEid: number;
  from?: string;
  simulate: boolean;
}): Promise<DirectOftAdapter> {
  const rpcUrl = args.rpcUrl ?? DEFAULT_RPC_URLS.solana[0];
  const connection = new Connection(rpcUrl, "confirmed");
  const umi = createUmi(rpcUrl);
  const storeKey = new PublicKey(args.storeAddress);
  const storeRaw = await connection.getAccountInfo(storeKey);
  if (
    !storeRaw ||
    toHex(storeRaw.data.subarray(0, 8)) !== STORE_DISCRIMINATOR
  ) {
    throw new Error(
      "This Solana OFT uses an unsupported store layout. No API fallback was used.",
    );
  }
  const programId = storeRaw.owner;
  if (
    args.deployment.details?.oftProgramId &&
    args.deployment.details.oftProgramId !== programId.toBase58()
  )
    throw new Error("Solana OFT program does not match metadata.");
  const store = oft.accounts
    .getOFTStoreAccountDataSerializer()
    .deserialize(storeRaw.data)[0];
  const program = publicKey(programId.toBase58());
  const pda = new OftPDA(program);
  if (pda.oftStore(store.tokenEscrow)[0] !== args.storeAddress || store.paused)
    throw new Error("Solana OFT store is invalid or paused.");
  if (store.tokenMint !== args.token.address)
    throw new Error("Solana OFT mint does not match the selected token.");
  const mintKey = new PublicKey(store.tokenMint);
  const peerKey = new PublicKey(
    pda.peer(publicKey(args.storeAddress), args.remoteEid)[0],
  );
  const [mintRaw, peerRaw, programRaw] = await Promise.all([
    connection.getAccountInfo(mintKey),
    connection.getAccountInfo(peerKey),
    connection.getAccountInfo(programId),
  ]);
  if (
    !programRaw?.executable ||
    !peerRaw?.owner.equals(programId) ||
    toHex(peerRaw.data.subarray(0, 8)) !== PEER_DISCRIMINATOR
  )
    throw new Error("Invalid Solana OFT program or peer account.");
  if (
    !mintRaw ||
    (!mintRaw.owner.equals(TOKEN_PROGRAM_ID) &&
      !mintRaw.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw new Error("Unsupported Solana token program.");
  const tokenProgram = mintRaw.owner;
  const mint = unpackMint(mintKey, mintRaw, tokenProgram);
  if (!mint.isInitialized) throw new Error("Solana mint is not initialized.");
  // Transfer hooks, transfer fees, and other behavioral extensions need separate handling.
  const extensions = getExtensionTypes(mint.tlvData);
  if (
    extensions.some(
      (extension) =>
        ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(
          extension,
        ),
    )
  )
    throw new Error("This Token-2022 mint uses unsupported extensions.");
  const peer = oft.accounts
    .getPeerConfigAccountDataSerializer()
    .deserialize(peerRaw.data)[0];
  let exponent = 0;
  let rate = store.ld2sdRate;
  while (rate > BigInt(1) && rate % BigInt(10) === BigInt(0)) {
    rate /= BigInt(10);
    exponent++;
  }
  if (rate !== BigInt(1) || exponent > mint.decimals)
    throw new Error("Invalid Solana OFT decimal conversion rate.");
  const payer = args.from ? publicKey(args.from) : undefined;
  const quoteAccounts = () => {
    if (!payer) throw new Error("Solana source wallet is required.");
    return {
      payer,
      tokenMint: store.tokenMint,
      tokenEscrow: store.tokenEscrow,
    };
  };
  const params = (value: LayerZeroOftV2SendParam) => ({
    dstEid: value.dstEid,
    to: hexToBytes(value.to),
    amountLd: value.amountLD,
    minAmountLd: value.minAmountLD,
    options: hexToBytes(value.extraOptions),
    payInLzToken: false,
  });
  const programs = { oft: program, endpoint: store.endpointProgram };
  return {
    addressBytes32: toHex(storeKey.toBytes()),
    tokenAddress: store.tokenMint,
    decimals: mint.decimals,
    sharedDecimals: mint.decimals - exponent,
    peer: toHex(peer.peerAddress),
    enforcedOptions: toHex(peer.enforcedOptions.send),
    receiveOptions: async (recipient, enforced) => {
      const owner = new PublicKey(recipient);
      const ata = getAssociatedTokenAddressSync(
        mintKey,
        owner,
        true,
        tokenProgram,
      );
      const account = await connection.getAccountInfo(ata);
      if (account) {
        const tokenAccount = unpackAccount(ata, account, tokenProgram);
        if (
          !tokenAccount.mint.equals(mintKey) ||
          !tokenAccount.owner.equals(owner) ||
          !tokenAccount.isInitialized ||
          tokenAccount.isFrozen
        )
          throw new Error(
            "Destination Solana token account is invalid or frozen.",
          );
        return "0x";
      }
      const size = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
        ? getAccountLen([ExtensionType.ImmutableOwner])
        : getAccountLen([]);
      const rent = BigInt(
        await connection.getMinimumBalanceForRentExemption(size),
      );
      return solanaRentExtraOptions(rent, enforced);
    },
    quoteOft: async (value) => {
      const result = await oft.quoteOft(
        umi.rpc,
        quoteAccounts(),
        params(value),
        program,
      );
      return {
        amountSentLD: result.oftReceipt.amountSentLd,
        amountReceivedLD: result.oftReceipt.amountReceivedLd,
        minAmountLD: result.oftLimits.minAmountLd,
        maxAmountLD: result.oftLimits.maxAmountLd,
      };
    },
    quoteSend: (value) =>
      oft.quote(
        umi.rpc,
        quoteAccounts(),
        params(value),
        programs,
        [],
        [publicKey(SOLANA_OFT_LOOKUP_TABLE)],
      ),
    buildSteps: async (value, fee) => {
      if (!payer) throw new Error("Solana source wallet is required.");
      const owner = new PublicKey(payer);
      const ata = getAssociatedTokenAddressSync(
        mintKey,
        owner,
        false,
        tokenProgram,
      );
      const account = await connection.getAccountInfo(ata);
      if (!account)
        throw new Error("Source Solana token account does not exist.");
      const tokenAccount = unpackAccount(ata, account, tokenProgram);
      if (
        !tokenAccount.owner.equals(owner) ||
        !tokenAccount.mint.equals(mintKey) ||
        !tokenAccount.isInitialized ||
        tokenAccount.isFrozen ||
        tokenAccount.amount < value.amountLD
      )
        throw new Error(
          "Source Solana token account is frozen or has insufficient balance.",
        );
      const ix = await oft.send(
        umi.rpc,
        {
          ...quoteAccounts(),
          payer: createNoopSigner(payer),
          tokenSource: publicKey(ata.toBase58()),
        },
        {
          ...params(value),
          nativeFee: fee.nativeFee,
          lzTokenFee: fee.lzTokenFee,
        },
        { ...programs, token: publicKey(tokenProgram.toBase58()) },
      );
      const lookup = (
        await connection.getAddressLookupTable(
          new PublicKey(SOLANA_OFT_LOOKUP_TABLE),
        )
      ).value;
      if (!lookup || !lookup.isActive())
        throw new Error("Solana OFT lookup table is unavailable.");
      const blockhash = await connection.getLatestBlockhash("confirmed");
      const transaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: owner,
          recentBlockhash: blockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
            toWeb3JsInstruction(ix.instruction),
          ],
        }).compileToV0Message([lookup]),
      );
      if (transaction.message.header.numRequiredSignatures !== 1)
        throw new Error("Unexpected extra signer in Solana OFT transaction.");
      if (args.simulate) {
        const simulation = await connection.simulateTransaction(transaction, {
          sigVerify: false,
          commitment: "confirmed",
        });
        if (simulation.value.err)
          throw new Error(
            `Solana OFT simulation failed: ${JSON.stringify(simulation.value.err)}`,
          );
      }
      const encoded = transaction.serialize();
      if (encoded.length > 1232)
        throw new Error(
          "Solana OFT transaction exceeds the packet size limit.",
        );
      return [
        {
          type: "TRANSACTION",
          chainType: "SOLANA",
          chainKey: "solana",
          description: "Send directly via Solana OFT",
          transaction: {
            encoded: {
              encoding: "base64",
              serializedTransaction: base64(encoded),
              blockhash: blockhash.blockhash,
              lastValidBlockHeight: blockhash.lastValidBlockHeight,
            },
          },
        },
      ];
    },
  };
}
