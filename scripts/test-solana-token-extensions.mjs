import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import ts from "typescript";
import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType as E,
  TransferFeeConfigLayout,
  TransferHookLayout,
  PausableConfigLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const require = createRequire(import.meta.url);
const mod = { exports: {} };
new Script(ts.transpileModule(
  readFileSync(new URL("../src/lib/solana-token-extensions.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText).runInNewContext({ module: mod, exports: mod.exports, require });
const { solanaOftTokenAccountSize: size } = mod.exports;
const zero = PublicKey.default;
const nonzero = new PublicKey(new Uint8Array(32).fill(1));
function tlv(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}
function encode(layout, value) {
  const data = Buffer.alloc(layout.span);
  layout.encode(value, data);
  return data;
}
const schedule = { epoch: 722n, maximumFee: 0n, transferFeeBasisPoints: 0 };
const fee = (older = schedule, newer = schedule) => tlv(E.TransferFeeConfig, encode(TransferFeeConfigLayout, {
  transferFeeConfigAuthority: nonzero, withdrawWithheldAuthority: nonzero,
  withheldAmount: 0n, olderTransferFee: older, newerTransferFee: newer,
}));
const hook = (programId = zero) => tlv(E.TransferHook, encode(TransferHookLayout, { authority: nonzero, programId }));
const mint = (...extensions) => ({ tlvData: Buffer.concat(extensions) });
assert.equal(size(mint(), TOKEN_PROGRAM_ID), 165);
assert.equal(size(mint(), TOKEN_2022_PROGRAM_ID), 170);
// USDG's complete extension set: admin and opt-in confidential features do not
// enlarge a new ordinary ATA. Fee and hook state are required even when disabled.
const usdg = mint(
  tlv(E.MintCloseAuthority, Buffer.alloc(32)),
  tlv(E.PermanentDelegate, Buffer.alloc(32)),
  fee(), tlv(E.ConfidentialTransferMint, Buffer.alloc(65)),
  tlv(16, Buffer.alloc(129)), hook(),
  tlv(E.MetadataPointer, Buffer.alloc(64)), tlv(E.TokenMetadata, Buffer.alloc(174)),
);
assert.equal(size(usdg, TOKEN_2022_PROGRAM_ID), 187);
assert.equal(size(mint(fee()), TOKEN_2022_PROGRAM_ID), 182);
assert.equal(size(mint(hook()), TOKEN_2022_PROGRAM_ID), 175);
const pausable = (paused) => tlv(E.PausableConfig, encode(PausableConfigLayout, { authority: nonzero, paused }));
assert.equal(size(mint(hook(), pausable(false)), TOKEN_2022_PROGRAM_ID), 179);
assert.throws(() => size(mint(pausable(true)), TOKEN_2022_PROGRAM_ID), /mint is paused/);
const charged = { ...schedule, maximumFee: 100n, transferFeeBasisPoints: 25 };
assert.throws(() => size(mint(fee(charged)), TOKEN_2022_PROGRAM_ID), /active or scheduled transfer fees/);
assert.throws(() => size(mint(fee(schedule, { ...charged, epoch: 999999n })), TOKEN_2022_PROGRAM_ID), /active or scheduled transfer fees/);
assert.equal(size(mint(fee({ ...charged, maximumFee: 0n })), TOKEN_2022_PROGRAM_ID), 182);
assert.equal(size(mint(fee({ ...charged, transferFeeBasisPoints: 0 })), TOKEN_2022_PROGRAM_ID), 182);
assert.throws(() => size(mint(hook(nonzero)), TOKEN_2022_PROGRAM_ID), /active transfer hook/);
assert.throws(() => size(mint(tlv(E.NonTransferable, Buffer.alloc(0))), TOKEN_2022_PROGRAM_ID), /unsupported extension/);
assert.throws(() => size(mint(tlv(65535, Buffer.alloc(0))), TOKEN_2022_PROGRAM_ID), /unsupported extension: 65535/);
// LayerZero uses instanceof Connection when simulating quotes. Duplicate web3
// versions otherwise cause "Invalid connection" after successful account reads.
const sdkRequire = createRequire(require.resolve("@layerzerolabs/oft-v2-solana-sdk"));
const lzRequire = createRequire(sdkRequire.resolve("@layerzerolabs/lz-solana-sdk-v2"));
assert.equal(lzRequire("@solana/web3.js").Connection, require("@solana/web3.js").Connection);
console.log("Token-2022: USDG extensions, zero-fee schedules, disabled hook, ATA rent sizes, active/unknown extension rejection, and shared SDK Connection passed.");
