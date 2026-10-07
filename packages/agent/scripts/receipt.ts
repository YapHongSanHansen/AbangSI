/** Net amount the seller received in a collection tx (Blockfrost tx UTxOs): outputs − inputs at the seller address. */
import { toMasumiSellerSigner } from "@x402/cardano";
import { blockfrost, required } from "../src/config.js";
import { TUSDM_UNIT } from "../src/constants.js";
const hash = process.argv[2];
const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: required("SELLER_MNEMONIC") }).sellerAddress;
const r = await fetch(`${blockfrost.baseUrl}/txs/${hash}/utxos`, { headers: { project_id: blockfrost.projectId } });
const tx = await r.json() as { inputs: any[]; outputs: any[] };
const sum = (rows: any[], unit: string) => rows.filter(x => x.address === seller && !x.collateral && !x.reference).reduce((s, x) => s + BigInt(x.amount.find((a: any) => a.unit === unit)?.quantity ?? 0), 0n);
const meta = await fetch(`${blockfrost.baseUrl}/txs/${hash}`, { headers: { project_id: blockfrost.projectId } }).then(r => r.json()) as any;
console.log(`tx ${hash} block ${meta.block_height} ${new Date(meta.block_time * 1000).toISOString()}`);
console.log(`seller ${seller}`);
console.log(`net tUSDM received: ${Number(sum(tx.outputs, TUSDM_UNIT) - sum(tx.inputs, TUSDM_UNIT)) / 1e6} (unit ${TUSDM_UNIT})`);
console.log(`net tADA change:    ${Number(sum(tx.outputs, "lovelace") - sum(tx.inputs, "lovelace")) / 1e6} (fee paid by seller included)`);