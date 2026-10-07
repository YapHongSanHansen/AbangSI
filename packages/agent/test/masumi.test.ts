/**
 * Proves ReelForge's seller-signed terms verify exactly the way a Masumi
 * Payment Service buyer node (Sokosumi's) checks them: rebuild the payload from
 * the decoded blockchainIdentifier, hash canonical-json, Mesh checkSignature.
 * Mirrors masumi-payment-service src/routes/api/purchases/shared.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkSignature, resolvePaymentKeyHash } from "@meshsdk/core";
import stringify from "canonical-json";
import { PrivateKey } from "@evolution-sdk/evolution";
import { toMasumiSellerSigner } from "@x402/cardano";
import { ESCROW_ADDRESS, TUSDM_UNIT } from "../src/constants.js";
import { decodeIdentifier, inputHash, issueTerms, registryAssetName, registryMetadata, resultHash, resultHashMip004, sha256 } from "../src/masumi.js";

const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: PrivateKey.generateMnemonic(256) });
const agentId = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "10" + "ab".repeat(28) + "000000";

test("standard terms verify with the Payment Service buyer check", async () => {
  const nonce = "0123456789abcdef0123";
  const input = { prompt: "neon city", aspect_ratio: "9:16" };
  const t = await issueTerms({
    identifierFromPurchaser: nonce, inputHash: inputHash(nonce, input), agentIdentifier: agentId,
    sellerAddress: seller.sellerAddress, funds: [{ amount: "1000000", unit: TUSDM_UNIT }], sign: seller.signTerms,
  });
  const d = decodeIdentifier(t.blockchainIdentifier)!;
  assert.equal(d.purchaserNonce, nonce);
  assert.equal(d.contract, ESCROW_ADDRESS);
  assert.equal(d.sellerIdentifier, t.sellerNonce + agentId);
  // Buyer side: rebuild from what Sokosumi forwards (terms + RequestedFunds), V2 shape.
  const rebuilt = {
    inputHash: t.inputHash, agentIdentifier: agentId, purchaserIdentifier: nonce, sellerIdentifier: d.sellerIdentifier,
    RequestedFunds: [{ amount: "1000000", unit: TUSDM_UNIT }],
    payByTime: String(t.payByTime), submitResultTime: String(t.submitResultTime), unlockTime: String(t.unlockTime),
    externalDisputeUnlockTime: String(t.externalDisputeUnlockTime), sellerAddress: seller.sellerAddress,
    sellerReturnAddress: null, smartContractAddress: d.contract, supportedPaymentSourceIndex: 0,
  };
  assert.equal(await checkSignature(sha256(stringify(rebuilt)), { signature: d.signature, key: d.key }), true);
  assert.equal(t.sellerVKey, resolvePaymentKeyHash(seller.sellerAddress));
  // Tampering with any signed field must fail.
  assert.equal(await checkSignature(sha256(stringify({ ...rebuilt, payByTime: String(t.payByTime + 1) })), { signature: d.signature, key: d.key }), false);
  // Deadline gaps (MPS minimums: 5 / 15 / 15 minutes).
  assert.ok(t.submitResultTime - t.payByTime >= 5 * 60_000 && t.unlockTime - t.submitResultTime >= 15 * 60_000 && t.externalDisputeUnlockTime - t.unlockTime >= 15 * 60_000);
});

test("MIP-004 hashes and Sokosumi escaped-result vector", () => {
  const nonce = "01234567890123456789";
  const result = 'line\n"next"\\end';
  assert.equal(resultHash(nonce, result), "36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3");
  assert.equal(resultHashMip004(nonce, result), "7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd");
  assert.equal(resultHash(nonce, "plain https://x/y.mp4"), resultHashMip004(nonce, "plain https://x/y.mp4"));
  assert.equal(inputHash(nonce, { b: 1, a: "x" }), sha256(`${nonce};{"a":"x","b":1}`));
});

test("registry asset name + metadata shape", () => {
  const name = registryAssetName("11".repeat(32), 1);
  assert.match(name, /^10[0-9a-f]{56}000000$/);
  const md = registryMetadata({
    name: "ReelForge", description: "x", apiBaseUrl: "https://a.example", authorName: "me",
    capability: { name: "reelforge-video", version: "1.0.0" }, tags: ["video"], exampleOutputs: [], image: "ipfs://x",
  });
  assert.equal(md.metadata_version, "2");
  assert.deepEqual(md.supported_payment_sources[0].pricing, { pricingType: "Dynamic" });
  assert.deepEqual(md.supported_payment_sources[0].settlement.address.join(""), ESCROW_ADDRESS);
  for (const v of JSON.stringify(md).match(/"[^"]*"/g)!) assert.ok(Buffer.byteLength(JSON.parse(v)) <= 64);
});