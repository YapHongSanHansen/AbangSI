import { blockfrost } from "../src/config.js";
const short = (s: string) => s.startsWith("addr_test1wzs4e6") ? "ESCROW" : s.slice(0, 18) + "..." + s.slice(-6);
for (const h of process.argv.slice(2)) {
  const t: any = await fetch(`${blockfrost.baseUrl}/txs/${h}/utxos`, { headers: { project_id: blockfrost.projectId } }).then(r => r.json());
  const m: any = await fetch(`${blockfrost.baseUrl}/txs/${h}`, { headers: { project_id: blockfrost.projectId } }).then(r => r.json());
  console.log(`\n${h.slice(0, 10)} fee ${Number(m.fees) / 1e6}`);
  for (const [k, rows] of [["IN ", t.inputs], ["OUT", t.outputs]] as Array<[string, any[]]>) for (const row of rows) {
    if (row.collateral) continue;
    const ada = Number(row.amount.find((x: any) => x.unit === "lovelace").quantity) / 1e6;
    const tok = row.amount.filter((x: any) => x.unit !== "lovelace").map((x: any) => `${Number(x.quantity) / 1e6} ${x.unit.slice(0, 6)}`).join(",");
    console.log(`  ${k} ${short(row.address).padEnd(30)} ${ada.toFixed(6)} tADA ${tok}`);
  }
}