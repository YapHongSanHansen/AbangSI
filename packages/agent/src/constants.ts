/** Network constants shared by the agent and its scripts. */
import { addressCredentials, masumiEscrowAddress, MASUMI_REGISTRY_POLICY_ID } from "@x402/cardano";

/** x402 network id. Preprod only — mainnet keys never belong in this repo. */
export const NETWORK = "cardano:preprod";

/** Masumi `vested_pay` V2 escrow on preprod, derived by @x402/cardano from the canonical deployment. */
export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);

/** Masumi registry V2 minting policy (global). */
export const REGISTRY_POLICY_ID = MASUMI_REGISTRY_POLICY_ID;

/**
 * Masumi's preprod tUSDM — the token Sokosumi prices and pays in. Not the x402
 * library default `USDM_PREPROD_ASSET` (policy e675b46e…), a different token.
 */
export const TUSDM_POLICY_ID = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde";
export const TUSDM_ASSET_NAME = "0014df10745553444d";
/** Blockfrost / registry form: `policy ++ name`. */
export const TUSDM_UNIT = TUSDM_POLICY_ID + TUSDM_ASSET_NAME;
/** x402 form: `policy.name`. */
export const TUSDM_X402_ASSET = `${TUSDM_POLICY_ID}.${TUSDM_ASSET_NAME}`;

export const explorerTx = (hash: string) => `https://preprod.cardanoscan.io/transaction/${hash}`;

/** Normalises `lovelace`/`""` and dotted/concatenated units to one comparable key. */
export function unitKey(unit: string): string {
  const u = unit.toLowerCase().replace(".", "");
  return u === "lovelace" ? "" : u;
}

/** Payment key hash of a key-credential address (`sellerVKey` in MIP-003). */
export function paymentKeyHash(address: string): string {
  const { payment } = addressCredentials(address);
  if (payment.isScript) throw new Error(`${address} has a script payment credential`);
  return payment.hash;
}

/** Joins a metadata value that may be chunked into ≤64-byte strings. */
export const metadataText = (value: unknown) =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : undefined;