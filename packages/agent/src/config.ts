/**
 * Runtime configuration. Everything comes from the repository-root `.env`
 * (never committed). Secrets are read lazily so scripts that do not need a
 * value never fail on its absence.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { toMasumiSellerSigner } from "@x402/cardano";
import { NETWORK, REGISTRY_POLICY_ID } from "./constants.js";

export const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));
loadEnv({ path: ROOT_ENV, quiet: true });

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the repository-root .env`);
  return value;
}
export const optional = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

export interface Blockfrost { baseUrl: string; projectId: string }

export const blockfrost: Blockfrost = {
  baseUrl: optional("BLOCKFROST_URL", "https://cardano-preprod.blockfrost.io/api/v0"),
  get projectId() { return required("BLOCKFROST_PROJECT_ID"); },
};

/** The selling wallet: signs purchase terms + escrow transactions and holds the registry NFT. */
export function sellerWallet() {
  const mnemonic = required("SELLER_MNEMONIC");
  const signer = toMasumiSellerSigner({ network: NETWORK, mnemonic });
  return { mnemonic, address: signer.sellerAddress, signTerms: signer.signTerms, signer };
}

export const port = Number(optional("PORT", "8080"));
/** Public HTTPS base URL (no trailing slash). Written into the registry NFT. */
export const publicUrl = () => required("PUBLIC_BASE_URL").replace(/\/+$/, "");

/** Registered price in Masumi tUSDM base units (6 decimals). Sokosumi lists tUSDM-priced agents. */
export const priceTusdmUnits = BigInt(optional("PRICE_TUSDM_UNITS", "5000000"));

/** Optional unlisted x402 price in lovelace (no registry claim). Empty disables it. */
export const priceLovelace = (() => {
  const value = (process.env.PRICE_LOVELACE ?? "10000000").trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("PRICE_LOVELACE must be a positive integer or empty");
  return BigInt(value);
})();

/** The registry asset id (`policy ++ assetName`) printed by `pnpm register`, once registered. */
export function agentIdentifier(): string | undefined {
  const id = optional("MASUMI_AGENT_IDENTIFIER").toLowerCase();
  if (!id) return undefined;
  if (!id.startsWith(REGISTRY_POLICY_ID) || id.length !== 120) {
    throw new Error("MASUMI_AGENT_IDENTIFIER must be the 120-hex registry asset id printed by `pnpm register`");
  }
  return id;
}

/** Where videos are produced. `mock` makes no Higgsfield calls (no credits spent). */
export const videoBackend = () => optional("VIDEO_BACKEND", "higgsfield") as "higgsfield" | "mock";

export const listing = () => ({
  name: optional("AGENT_NAME", "ReelForge"),
  description: optional(
    "AGENT_DESCRIPTION",
    "ReelForge turns a prompt into a short AI-generated video reel (Higgsfield). Paid via Masumi escrow; x402 supported.",
  ),
  apiBaseUrl: publicUrl(),
  authorName: optional("AGENT_AUTHOR", "ReelForge"),
  tags: optional("AGENT_TAGS", "video,ai-video,reels,higgsfield,x402").split(",").map(t => t.trim()).filter(Boolean),
  image: optional("AGENT_IMAGE", "ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f"),
  priceUnits: priceTusdmUnits,
});