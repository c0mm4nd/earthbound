import { Address, beginCell } from "@ton/core";
// Reviewed OFTSend::New layout (FunC++ 350-bit header, seven descriptors).
// Compared against the official SDK serializer and deployed getLzSendMd in tests.
export function tonOftSendCell(dstEid: number, to: string, amount: bigint, fee: bigint) {
  const b = beginCell().storeUint(BigInt("0x4f465453656e64"), 80);
  for (const [type, offset, ref] of [[5, 350, 3], [8, 382, 3], [7, 638, 3], [7, 766, 3], [7, 894, 3], [9, 1023, 0], [9, 1023, 1]])
    b.storeUint(type, 4).storeUint(0, 2).storeUint(offset, 10).storeUint(ref, 2);
  b.storeUint((BigInt(1) << BigInt(144)) - BigInt(1), 144);
  return b.storeUint(dstEid, 32).storeUint(BigInt(to), 256).storeUint(amount, 128).storeUint(fee, 128).storeUint(0, 128)
    .storeRef(beginCell().endCell()).storeRef(beginCell().endCell()).endCell();
}
export function tonOftTransfer(args: { master: string; owner: string; dstEid: number; to: string; amount: bigint; fee: bigint; forward: bigint }) {
  return beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(args.amount)
    .storeAddress(Address.parse(args.master)).storeAddress(Address.parse(args.owner)).storeBit(false)
    .storeCoins(args.forward).storeBit(true).storeRef(tonOftSendCell(args.dstEid, args.to, args.amount, args.fee)).endCell();
}
