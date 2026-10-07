/** Proves the vendored Masumi blueprints are byte-for-byte the live preprod contracts. */
import { assertCanonicalContracts, blueprint } from "../src/contracts.js";
import { ESCROW_ADDRESS } from "../src/constants.js";
import { MASUMI_DEFAULT_DEPLOYMENT } from "@x402/cardano";

const { escrowScriptHash, registryPolicyId } = assertCanonicalContracts();
for (const f of ["payment-v2.plutus.json", "registry-v2.plutus.json"]) {
  const p = blueprint(f).preamble;
  console.log(`${f}: ${p.title} v${p.version}, ${p.plutusVersion}, ${p.compiler?.name} ${p.compiler?.version}`);
}
console.log("vested_pay script hash  ", escrowScriptHash);
console.log("escrow address (preprod)", ESCROW_ADDRESS);
console.log("deployment params        ", JSON.stringify(MASUMI_DEFAULT_DEPLOYMENT));
console.log("registry policy id      ", registryPolicyId);
console.log("OK: contracts match the canonical Masumi preprod deployment");