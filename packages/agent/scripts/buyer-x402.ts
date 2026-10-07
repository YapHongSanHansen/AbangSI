/**
 * Headless x402 buyer: pays ReelForge into Masumi escrow with the BUYER wallet.
 *   pnpm buy ["<prompt>"] [--tusdm]
 * Flow: POST → 402 (PAYMENT-REQUIRED with seller-signed Masumi terms) → client
 * verifies the seller signature + commitment, builds & signs the vested_pay lock
 * (not broadcast) → paid retry with PAYMENT-SIGNATURE → facilitator verifies,
 * ReelForge records the job, facilitator settles (broadcast + 1 confirmation).
 */
import { toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { blockfrost, optional, publicUrl, required } from "../src/config.js";
import { explorerTx, NETWORK, TUSDM_X402_ASSET } from "../src/constants.js";

const tusdm = process.argv.includes("--tusdm");
const prompt = process.argv.slice(2).filter(a => !a.startsWith("--")).join(" ") || "A neon-lit Singapore skyline at night, slow cinematic drone push-in";
const signer = toClientCardanoSigner({ mnemonic: required("BUYER_MNEMONIC"), network: NETWORK, provider: { blockfrost: { baseUrl: blockfrost.baseUrl, projectId: blockfrost.projectId } } });
const client = new x402Client().setSpendControls({
  allowedAssets: [
    { network: "cardano:*", asset: "lovelace", maxAmountPerPayment: "15000000" },
    { network: "cardano:*", asset: TUSDM_X402_ASSET, maxAmountPerPayment: "5000000" },
  ],
});
client.register("cardano:*", new ExactCardanoScheme(signer));
const url = `${optional("AGENT_URL") || publicUrl()}/x402/generate${tusdm ? "/tusdm" : ""}`;
console.log(`POST ${url}\n  prompt: ${prompt}`);
const res = await wrapFetchWithPayment(fetch, client)(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input_data: { prompt, aspect_ratio: "9:16" } }),
});
const body: any = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Payment failed: HTTP ${res.status}`, JSON.stringify(body).slice(0, 500)); process.exit(1); }
const receipt = new x402HTTPClient(client).getPaymentSettleResponse(n => res.headers.get(n));
console.log(`job ${body.job_id} status=${body.status}`);
console.log(`escrow lock ${receipt?.transaction} (${receipt?.extra?.status ?? "?"})\n  ${explorerTx(String(receipt?.transaction))}`);
console.log(`track: ${publicUrl()}/jobs/${body.job_id}`);