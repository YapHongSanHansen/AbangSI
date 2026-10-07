/** The lock matcher is the gate before any work: every signed field must match the on-chain datum. */
import test from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@evolution-sdk/evolution";
import { toMasumiSellerSigner, type MasumiDatumView } from "@x402/cardano";
import { lockMismatch, type EscrowLock, type ExpectedLock } from "../src/chain.js";
import { paymentKeyHash, TUSDM_UNIT } from "../src/constants.js";

const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: PrivateKey.generateMnemonic(256) }).sellerAddress;
const expected: ExpectedLock = {
  sellerAddress: seller, referenceKey: "a1", referenceSignature: "55".repeat(16), sellerNonce: "11".repeat(32),
  buyerNonce: "0123456789abcdef0123", agentIdentifier: "67ab".padEnd(120, "0"), inputHash: "44".repeat(32),
  payByTime: 1n, submitResultTime: 2n, unlockTime: 3n, externalDisputeUnlockTime: 4n, unit: TUSDM_UNIT, amount: 1_000_000n,
};
const cred = (hash: string) => ({ payment: { isScript: false, hash } });
const datum = (o: Partial<MasumiDatumView> = {}): MasumiDatumView => ({
  buyer: cred("22".repeat(28)), buyerReturnAddress: null, seller: cred(paymentKeyHash(seller)), sellerReturnAddress: null,
  referenceKey: "a1", referenceSignature: "55".repeat(16), sellerNonce: "11".repeat(32), buyerNonce: "0123456789abcdef0123",
  agentIdentifier: "67ab".padEnd(120, "0"), collateralReturnLovelace: 1_500_000n, inputHash: "44".repeat(32), resultHash: "",
  payByTime: 1n, submitResultTime: 2n, unlockTime: 3n, externalDisputeUnlockTime: 4n, sellerCooldownTime: 0n, buyerCooldownTime: 0n, state: 0n, ...o,
});
const lock = (d: MasumiDatumView | null, tokens: Record<string, bigint> = { [TUSDM_UNIT]: 1_000_000n }): EscrowLock =>
  ({ txHash: "aa".repeat(32), outputIndex: 0, datum: d, lovelace: 2_000_000n, tokens, hasReferenceScript: false, utxo: {} as never });

test("accepts a lock that matches every signed field", () => assert.equal(lockMismatch(lock(datum()), expected), null));
test("rejects wrong seller / nonce / input hash / deadline / state", () => {
  assert.match(lockMismatch(lock(datum({ seller: cred("33".repeat(28)) })), expected)!, /seller/);
  assert.match(lockMismatch(lock(datum({ buyerNonce: "ff".repeat(10) })), expected)!, /buyer_nonce/);
  assert.match(lockMismatch(lock(datum({ inputHash: "00".repeat(32) })), expected)!, /input_hash/);
  assert.match(lockMismatch(lock(datum({ unlockTime: 99n })), expected)!, /unlock_time/);
  assert.match(lockMismatch(lock(datum({ state: 1n })), expected)!, /FundsLocked/);
  assert.match(lockMismatch(lock(datum({ sellerReturnAddress: cred("44".repeat(28)) })), expected)!, /return address/);
});
test("rejects underpayment and missing datum", () => {
  assert.match(lockMismatch(lock(datum(), { [TUSDM_UNIT]: 999_999n }), expected)!, /paid/);
  assert.match(lockMismatch(lock(null), expected)!, /datum/);
});