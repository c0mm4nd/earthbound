import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  getAccountLen,
  getExtensionTypes,
  getTransferFeeConfig,
  getTransferHook,
  getPausableConfig,
  TOKEN_2022_PROGRAM_ID,
  type Mint,
} from "@solana/spl-token";

// Token-2022's on-chain enum includes this mint extension, but spl-token 0.4
// has not exposed it yet. It only configures fees for confidential transfers.
// https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;

/** Validate ordinary OFT transfers and return the size of a newly created ATA. */
export function solanaOftTokenAccountSize(mint: Mint, tokenProgram: PublicKey): number {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return getAccountLen([]);

  const accountExtensions = [ExtensionType.ImmutableOwner];
  // Numeric tags can include on-chain variants absent from the SDK enum.
  const extensions: number[] = getExtensionTypes(mint.tlvData);
  for (const extension of extensions) {
    switch (extension) {
      case ExtensionType.MetadataPointer:
      case ExtensionType.TokenMetadata:
      case ExtensionType.MintCloseAuthority:
      case ExtensionType.PermanentDelegate:
      case ExtensionType.ConfidentialTransferMint:
      case CONFIDENTIAL_TRANSFER_FEE_CONFIG:
        // These do not change ordinary public-balance transfers. Confidential
        // account extensions are opt-in, not required when creating an ATA.
        break;
      case ExtensionType.TransferFeeConfig: {
        const config = getTransferFeeConfig(mint);
        // Check both schedules so an epoch transition cannot introduce a fee
        // between the quote and destination execution.
        if (!config || [config.olderTransferFee, config.newerTransferFee].some(
          (fee) => fee.transferFeeBasisPoints !== 0 && fee.maximumFee !== BigInt(0),
        )) {
          throw new Error("This Token-2022 mint has active or scheduled transfer fees, which direct OFT does not support.");
        }
        accountExtensions.push(ExtensionType.TransferFeeAmount);
        break;
      }
      case ExtensionType.TransferHook: {
        const hook = getTransferHook(mint);
        if (!hook || !hook.programId.equals(PublicKey.default)) {
          throw new Error("This Token-2022 mint has an active transfer hook, which direct OFT does not support.");
        }
        accountExtensions.push(ExtensionType.TransferHookAccount);
        break;
      }
      case ExtensionType.PausableConfig: {
        const config = getPausableConfig(mint);
        if (!config || config.paused) throw new Error("This Token-2022 mint is paused.");
        accountExtensions.push(ExtensionType.PausableAccount);
        break;
      }
      default:
        throw new Error(`This Token-2022 mint uses an unsupported extension: ${ExtensionType[extension] ?? extension}.`);
    }
  }
  // Mirrors Token-2022 required_init_account_extensions plus the ATA program's
  // ImmutableOwner. getAccountLenForMint in spl-token 0.4 incorrectly includes
  // optional confidential account state and cannot handle extension type 16.
  return getAccountLen(accountExtensions);
}
