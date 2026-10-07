/**
 * Points ReelForge's Masumi registry entry at the current PUBLIC_BASE_URL (e.g. after
 * moving hosts) via the registry UpdateAction, then saves the new MASUMI_AGENT_IDENTIFIER.
 *   pnpm update-registry            (uses PUBLIC_BASE_URL from .env)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { agentIdentifier, blockfrost, listing, optional, ROOT_ENV, sellerWallet } from "../src/config.js";
import { createChain } from "../src/chain.js";
import { explorerTx } from "../src/constants.js";
import { registryMetadata } from "../src/masumi.js";

const current = agentIdentifier();
if (!current) throw new Error("not registered yet — use pnpm register");
const l = listing();
const ok = await fetch(`${l.apiBaseUrl}/availability`).then(r => r.ok).catch(() => false);
if (!ok) throw new Error(`${l.apiBaseUrl}/availability is not reachable — finish the deployment first`);
const metadata = registryMetadata({
  name: l.name, description: l.description, apiBaseUrl: l.apiBaseUrl, authorName: l.authorName,
  authorOrganization: optional("AGENT_ORGANIZATION", "TOKEN2049 Origins Hackathon 2026"),
  capability: { name: "reelforge-video", version: "1.1.0" }, tags: l.tags, image: l.image,
  exampleOutputs: optional("AGENT_EXAMPLE_URL") ? [{ name: "Sample reel", mimeType: "video/mp4", url: optional("AGENT_EXAMPLE_URL") }] : [],
});
const seller = sellerWallet();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address, log: console.log });
console.log(`updating ${current}\n  → api_base_url ${l.apiBaseUrl}`);
const { txHash, agentIdentifier: next } = await chain.updateRegistry(current, metadata);
console.log(`confirmed ${explorerTx(txHash)}\nMASUMI_AGENT_IDENTIFIER=${next}`);
const env = readFileSync(ROOT_ENV, "utf8");
writeFileSync(ROOT_ENV, env.replace(/^MASUMI_AGENT_IDENTIFIER=.*$/m, `MASUMI_AGENT_IDENTIFIER=${next}`));
console.log("saved to .env — restart the agent");