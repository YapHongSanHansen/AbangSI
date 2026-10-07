/** Prints tADA / tUSDM balances of the ReelForge wallets (Blockfrost). */
import { toMasumiSellerSigner } from "@x402/cardano";
import { blockfrost, optional } from "../src/config.js";
import { ESCROW_ADDRESS, NETWORK, TUSDM_UNIT } from "../src/constants.js";

async function balance(address: string) {
  const r = await fetch(`${blockfrost.baseUrl}/addresses/${address}`, { headers: { project_id: blockfrost.projectId } });
  if (r.status === 404) return { ada: 0, tusdm: 0, other: 0 };
  if (!r.ok) throw new Error(`Blockfrost ${r.status}`);
  const amounts = (await r.json() as { amount: Array<{ unit: string; quantity: string }> }).amount;
  const q = (u: string) => Number(amounts.find(a => a.unit === u)?.quantity ?? 0);
  return { ada: q("lovelace") / 1e6, tusdm: q(TUSDM_UNIT) / 1e6, other: amounts.length - 1 - (q(TUSDM_UNIT) ? 1 : 0) };
}
for (const [label, name] of [["seller", "SELLER_MNEMONIC"], ["buyer", "BUYER_MNEMONIC"]] as const) {
  const m = optional(name);
  if (!m) { console.log(`${label}: not created (pnpm wallets)`); continue; }
  const address = toMasumiSellerSigner({ network: NETWORK, mnemonic: m }).sellerAddress;
  const b = await balance(address);
  console.log(`${label.padEnd(6)} ${address}\n       ${b.ada} tADA, ${b.tusdm} tUSDM, ${b.other} other token(s)`);
}
console.log(`escrow ${ESCROW_ADDRESS}`);