/**
 * Registers ReelForge on the Masumi registry (preprod) by minting its registry
 * V2 NFT to the seller wallet. Metadata: Standard (MIP-003) agent, one Cardano
 * Preprod `Web3CardanoV2` source on the canonical escrow, `Dynamic` pricing.
 * Writes MASUMI_AGENT_IDENTIFIER into the root .env.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { agentIdentifier, blockfrost, listing, optional, ROOT_ENV, sellerWallet } from "../src/config.js";
import { createChain } from "../src/chain.js";
import { explorerTx } from "../src/constants.js";
import { registryMetadata } from "../src/masumi.js";

if (agentIdentifier() && !process.argv.includes("--force")) {
  console.log(`Already registered: ${agentIdentifier()} (use --force to mint another entry)`);
  process.exit(0);
}
const l = listing();
const availability = await fetch(`${l.apiBaseUrl}/availability`).then(r => r.ok).catch(() => false);
if (!availability) throw new Error(`${l.apiBaseUrl}/availability is not reachable — start the server and tunnel first`);

const metadata = registryMetadata({
  name: l.name,
  description: l.description,
  apiBaseUrl: l.apiBaseUrl,
  authorName: l.authorName,
  authorOrganization: optional("AGENT_ORGANIZATION", "TOKEN2049 Origins Hackathon 2026"),
  capability: { name: "reelforge-video", version: "1.0.0" },
  tags: l.tags,
  exampleOutputs: optional("AGENT_EXAMPLE_URL") ? [{ name: "Sample reel", mimeType: "video/mp4", url: optional("AGENT_EXAMPLE_URL") }] : [],
  image: l.image,
});
const seller = sellerWallet();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address, log: console.log });
console.log(`Registering ${l.name} → ${l.apiBaseUrl} (seller ${seller.address})`);
const { txHash, agentIdentifier: id } = await chain.register(metadata);
console.log(`confirmed ${explorerTx(txHash)}`);
console.log(`MASUMI_AGENT_IDENTIFIER=${id}`);
const env = readFileSync(ROOT_ENV, "utf8");
writeFileSync(ROOT_ENV, /^MASUMI_AGENT_IDENTIFIER=.*$/m.test(env) ? env.replace(/^MASUMI_AGENT_IDENTIFIER=.*$/m, `MASUMI_AGENT_IDENTIFIER=${id}`) : `${env.trimEnd()}\nMASUMI_AGENT_IDENTIFIER=${id}\n`);
console.log("saved to .env — restart the server so /start_job uses it");