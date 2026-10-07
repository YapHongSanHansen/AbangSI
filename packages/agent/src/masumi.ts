/**
 * Masumi protocol helpers for ReelForge (pure; no network access):
 *   - MIP-004 input / result hashes (+ Sokosumi's escaped-result variant)
 *   - registry V2 asset naming and CIP-25 (label 721) metadata
 *   - seller-signed purchase terms identical to what a Masumi Payment Service
 *     issues (`POST /payment`), so Sokosumi's buyer node accepts them
 *   - vested_pay datum transitions (SubmitResult)
 *
 * Wire formats follow masumi-network/masumi-payment-service (MIT):
 * src/utils/generator/blockchain-identifier-payload.ts,
 * src/routes/api/payments/index.ts, packages/payment-source-v2/.../register/metadata.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { Data } from "@evolution-sdk/evolution";
import { jcs, MASUMI_PAYMENT_SOURCE_TYPE } from "@x402/cardano";
import stringify from "canonical-json";
import LZString from "lz-string";
import { ESCROW_ADDRESS, paymentKeyHash } from "./constants.js";

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------- nonces + hashes

/** A purchaser nonce Masumi accepts: 14–26 lowercase hex chars, even length. */
export const NONCE_RE = /^(?:[0-9a-f]{2}){7,13}$/;
export const newPurchaserNonce = () => randomBytes(10).toString("hex");

/** MIP-004 input hash: sha256(nonce + ";" + JCS(input)). */
export function inputHash(nonce: string, input: unknown): string {
  return sha256(`${nonce};${jcs(input)}`);
}

/**
 * Result hash. Sokosumi verifies `sha256(nonce + ";" + JSON.stringify(result).slice(1,-1))`
 * (escaped text), which equals raw MIP-004 whenever the result has no quotes,
 * backslashes or control characters. ReelForge keeps results escape-free where
 * possible and always submits the Sokosumi-compatible form.
 */
export function resultHash(nonce: string, result: string): string {
  return sha256(`${nonce};${JSON.stringify(result).slice(1, -1)}`);
}
export const resultHashMip004 = (nonce: string, result: string) => sha256(`${nonce};${result}`);

// ---------------------------------------------------------------- registry

/** Registry V2 asset name: 0x10 ‖ blake2b_224(seed tx id ‖ u32be(index)) ‖ 000000 (registry-v2 mint.ak). */
export function registryAssetName(seedTxHash: string, seedIndex: number): string {
  const ref = Buffer.alloc(36);
  Buffer.from(seedTxHash, "hex").copy(ref, 0);
  ref.writeUInt32BE(seedIndex, 32);
  return `10${Buffer.from(blake2b(ref, { dkLen: 28 })).toString("hex")}000000`;
}

/** Cardano metadata strings are ≤64 bytes; Masumi always emits arrays of ≤60-byte chunks. */
export function chunk(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (Buffer.byteLength(current + ch) > 60 && current) { out.push(current); current = ""; }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

export interface RegistryListing {
  name: string;
  description: string;
  apiBaseUrl: string;
  authorName: string;
  authorContactEmail?: string;
  authorOrganization?: string;
  capability: { name: string; version: string };
  tags: string[];
  exampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
  image: string;
  termsUrl?: string;
  privacyUrl?: string;
}

/**
 * Registry V2 metadata for a Standard (MIP-003) agent with one Cardano preprod
 * `Web3CardanoV2` source and `Dynamic` pricing — the shape the TOKEN2049 guide
 * prescribes and a Masumi Payment Service mints for `POST /registry`.
 */
export function registryMetadata(a: RegistryListing) {
  if (a.description.length > 250) throw new Error("description must be ≤250 characters");
  if (a.tags.length < 1 || a.tags.length > 15 || a.tags.some(t => !t || Buffer.byteLength(t) > 63)) throw new Error("1–15 tags, each ≤63 bytes");
  const opt = (v?: string) => (v ? chunk(v) : undefined);
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return {
    name: chunk(a.name),
    description: chunk(a.description),
    api_base_url: chunk(a.apiBaseUrl),
    example_output: a.exampleOutputs.map(e => ({ name: chunk(e.name), mime_type: chunk(e.mimeType), url: chunk(e.url) })),
    capability: { name: chunk(a.capability.name), version: chunk(a.capability.version) },
    author: strip({ name: chunk(a.authorName), contact_email: opt(a.authorContactEmail), organization: opt(a.authorOrganization) }),
    legal: strip({ privacy_policy: opt(a.privacyUrl), terms: opt(a.termsUrl) }),
    tags: a.tags,
    image: chunk(a.image),
    metadata_version: "2",
    supported_payment_sources: [{
      chain: chunk("Cardano"),
      network: chunk("Preprod"),
      settlement: { paymentSourceType: chunk(MASUMI_PAYMENT_SOURCE_TYPE), address: chunk(ESCROW_ADDRESS) },
      pricing: { pricingType: "Dynamic" },
    }],
  };
}

// ---------------------------------------------------------------- seller-signed terms

/** CIP-30/CIP-8 `signData(address, payloadHex)` (e.g. `toMasumiSellerSigner(...).signTerms`). */
export type SignData = (address: string, payloadHex: string) => Promise<{ key: string; signature: string }> | { key: string; signature: string };

export interface Funds { amount: string; unit: string }

/** Deadlines (ms after issuance). Satisfy MPS rules: pay→submit ≥5 min, submit→unlock ≥15, unlock→dispute ≥15. */
export const DEADLINES = {
  payBy: 15 * 60_000,
  submitResult: 40 * 60_000,
  unlock: 60 * 60_000,
  externalDisputeUnlock: 80 * 60_000,
};

export interface SignedTerms {
  blockchainIdentifier: string;
  identifierFromPurchaser: string;
  agentIdentifier: string;
  sellerVKey: string;
  sellerAddress: string;
  inputHash: string;
  payByTime: number;
  submitResultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
  RequestedFunds: Funds[];
  paymentSourceType: string;
  supportedPaymentSourceIndex: number;
  sellerNonce: string;
  referenceKey: string;
  referenceSignature: string;
}

/**
 * Issues purchase terms exactly as a Masumi Payment Service seller does:
 * build the signed-identifier payload, sign sha256(canonical-json(payload))
 * with CIP-8 from the seller (registry NFT holder) address, then LZString-pack
 * `sellerNonce‖agentId . purchaserNonce . signature . key . escrow`.
 */
export async function issueTerms(input: {
  identifierFromPurchaser: string;
  inputHash: string;
  agentIdentifier: string;
  sellerAddress: string;
  funds: Funds[];
  sign: SignData;
  now?: number;
  deadlines?: typeof DEADLINES;
}): Promise<SignedTerms> {
  if (!NONCE_RE.test(input.identifierFromPurchaser)) throw new Error("identifier_from_purchaser must be 14–26 lowercase hex");
  if (!/^[0-9a-f]{64}$/.test(input.inputHash)) throw new Error("inputHash must be 64 hex");
  const now = input.now ?? Date.now();
  const d = input.deadlines ?? DEADLINES;
  const t = {
    payByTime: now + d.payBy,
    submitResultTime: now + d.submitResult,
    unlockTime: now + d.unlock,
    externalDisputeUnlockTime: now + d.externalDisputeUnlock,
  };
  const sellerNonce = sha256(randomBytes(32).toString("hex"));
  const sellerIdentifier = sellerNonce + input.agentIdentifier;
  const supportedPaymentSourceIndex = 0;
  const RequestedFunds = input.funds.map(f => ({ amount: f.amount, unit: f.unit.toLowerCase() === "lovelace" ? "" : f.unit }));
  // Field order is irrelevant (canonical-json sorts), field presence is not.
  const payload = {
    inputHash: input.inputHash,
    agentIdentifier: input.agentIdentifier,
    purchaserIdentifier: input.identifierFromPurchaser,
    sellerIdentifier,
    RequestedFunds, // Dynamic pricing: the signed amounts; Fixed would be null
    payByTime: String(t.payByTime),
    submitResultTime: String(t.submitResultTime),
    unlockTime: String(t.unlockTime),
    externalDisputeUnlockTime: String(t.externalDisputeUnlockTime),
    sellerAddress: input.sellerAddress,
    sellerReturnAddress: null,
    smartContractAddress: ESCROW_ADDRESS,
    supportedPaymentSourceIndex,
  };
  const { key, signature } = await input.sign(input.sellerAddress, sha256(stringify(payload)));
  const identifier = [sellerIdentifier, input.identifierFromPurchaser, signature, key, ESCROW_ADDRESS].join(".");
  return {
    blockchainIdentifier: Buffer.from(LZString.compressToUint8Array(identifier)).toString("hex"),
    identifierFromPurchaser: input.identifierFromPurchaser,
    agentIdentifier: input.agentIdentifier,
    sellerVKey: paymentKeyHash(input.sellerAddress),
    sellerAddress: input.sellerAddress,
    inputHash: input.inputHash,
    ...t,
    RequestedFunds,
    paymentSourceType: MASUMI_PAYMENT_SOURCE_TYPE,
    supportedPaymentSourceIndex,
    sellerNonce,
    referenceKey: key,
    referenceSignature: signature,
  };
}

/** Decodes a blockchainIdentifier back into its five segments (inverse of the packing above). */
export function decodeIdentifier(blockchainIdentifier: string) {
  const text = LZString.decompressFromUint8Array(Uint8Array.from(Buffer.from(blockchainIdentifier, "hex")));
  const parts = text?.split(".");
  if (!parts || parts.length !== 5) return null;
  return { sellerIdentifier: parts[0], purchaserNonce: parts[1], signature: parts[2], key: parts[3], contract: parts[4] };
}

// ---------------------------------------------------------------- vested_pay datum

export const STATE = { FundsLocked: 0n, ResultSubmitted: 1n, RefundRequested: 2n, Disputed: 3n, WithdrawAuthorized: 4n, RefundAuthorized: 5n } as const;
export const STATE_NAME = Object.fromEntries(Object.entries(STATE).map(([k, v]) => [String(v), k])) as Record<string, string>;

/** SubmitResult continuation: same datum except result_hash (11), seller_cooldown (16), buyer_cooldown=0 (17), state (18). */
export function submitResultDatum(lock: Data.Data, resultHashHex: string, sellerCooldownTime: bigint): Data.Data {
  if (!Data.isConstr(lock) || lock.index !== 0n || lock.fields.length !== 19) throw new Error("Not a vested_pay V2 datum");
  if (!/^[0-9a-f]{64}$/.test(resultHashHex)) throw new Error("result hash must be 32 bytes hex");
  const fields = [...lock.fields];
  const state = Data.isConstr(fields[18]) ? fields[18].index : -1n;
  const next = state === STATE.FundsLocked || state === STATE.ResultSubmitted ? STATE.ResultSubmitted : STATE.Disputed;
  fields[11] = Data.bytearray(resultHashHex);
  fields[16] = Data.int(sellerCooldownTime);
  fields[17] = Data.int(0n);
  fields[18] = Data.constr(next, []);
  return Data.constr(0n, fields);
}