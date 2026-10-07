/** Independent on-chain verification of every ReelForge job via Blockfrost (preprod). */
import { readFileSync } from "node:fs";
import { toMasumiSellerSigner } from "@x402/cardano";
import { blockfrost, optional, required } from "../src/config.js";
import { ESCROW_ADDRESS, TUSDM_UNIT } from "../src/constants.js";
import { STATE_NAME } from "../src/masumi.js";
import { createChain } from "../src/chain.js";

const bf = async (p: string) => { const r = await fetch(`${blockfrost.baseUrl}${p}`, { headers: { project_id: blockfrost.projectId } }); return r.ok ? r.json() as Promise<any> : null; };
const tx = async (h?: string) => { if (!h || h === "unpaid" || h === "unknown-spent") return "-"; const t = await bf(`/txs/${h}`); return t ? `block ${t.block_height} ✓` : "NOT FOUND"; };
const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: required("SELLER_MNEMONIC") }).sellerAddress;
const chain = createChain({ blockfrost, mnemonic: required("SELLER_MNEMONIC"), sellerAddress: seller });
const jobs = JSON.parse(readFileSync(new URL("../data/jobs.json", import.meta.url), "utf8")) as any[];
const tip = await bf("/blocks/latest");
console.log(`chain tip: block ${tip.height} (${new Date(tip.time * 1000).toISOString().slice(11, 19)} UTC)\n`);
for (const j of jobs) {
  let escrow = "-";
  if (j.resultTx && j.resultTx !== "unpaid") {
    const [l] = await chain.locksOfTx(j.resultTx);
    escrow = l?.datum ? `${STATE_NAME[String(l.datum.state)]} (result_hash ${l.datum.resultHash === j.resultHash ? "matches" : "MISMATCH"}), unlock ${new Date(Number(l.datum.unlockTime)).toISOString().slice(11, 16)}` : "spent (withdrawn)";
  } else if (j.lockTx) {
    const l = await chain.lockByRef(j.lockTx, j.lockIndex ?? 0);
    escrow = l?.datum ? `${STATE_NAME[String(l.datum.state)]}` : "not yet / spent";
  }
  console.log(`${j.id.slice(0, 8)} ${j.channel.padEnd(8)} ${j.status.padEnd(16)} lock ${await tx(j.lockTx)} | result ${await tx(j.resultTx)} | collect ${await tx(j.collectTx)}\n         escrow now: ${escrow}`);
}
for (const [label, addr] of [["seller", seller], ["buyer", toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: required("BUYER_MNEMONIC") }).sellerAddress]]) {
  const a = await bf(`/addresses/${addr}`);
  const q = (u: string) => Number(a?.amount?.find((x: any) => x.unit === u)?.quantity ?? 0) / 1e6;
  console.log(`\n${label} ${addr}\n  ${q("lovelace")} tADA, ${q(TUSDM_UNIT)} tUSDM`);
}
console.log(`\nregistry NFT held by seller: ${(await bf(`/assets/${optional("MASUMI_AGENT_IDENTIFIER")}/addresses`))?.some((h: any) => h.address === seller) ? "yes" : "NO"}`);
console.log(`escrow contract: ${ESCROW_ADDRESS}`);