/**
 * Masumi on-chain contracts used by ReelForge (vendored, MIT, from
 * masumi-network/masumi-payment-service — see contracts/NOTICE.md):
 *
 *   payment-v2  `vested_pay` escrow (Plutus V3), parameterised by
 *               (required_admins_multi_sig, admin_vks, cooldown_period)
 *   registry-v2 agent registry NFT minting policy (Plutus V3, unparameterised)
 *
 * Cardano scripts are not "deployed" like EVM contracts: a script's address is
 * the hash of its code + parameters. Masumi already operates the canonical
 * preprod escrow and registry, so ReelForge applies the canonical parameters
 * and asserts the result hashes to exactly the address/policy @x402/cardano and
 * the Masumi registry use. A mismatch aborts — funds are never sent to a
 * look-alike script.
 */
import { readFileSync } from "node:fs";
import { CBOR, Data, PlutusV3, ScriptHash, UPLC } from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, masumiEscrowScriptHash } from "@x402/cardano";
import { REGISTRY_POLICY_ID } from "./constants.js";

interface Blueprint {
  preamble: { title: string; version: string; plutusVersion: string; compiler?: { name: string; version: string } };
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}

export const blueprint = (file: string): Blueprint =>
  JSON.parse(readFileSync(new URL(`../contracts/${file}`, import.meta.url), "utf8"));

const spendValidator = (bp: Blueprint, title: string) => {
  const v = bp.validators.find(x => x.title === title);
  if (!v) throw new Error(`Validator ${title} not found in blueprint`);
  return v;
};

/** `vested_pay` with the canonical Masumi preprod parameters (2-of-3 admins, 420 000 ms cooldown). */
export function paymentScript(deployment = MASUMI_DEFAULT_DEPLOYMENT): PlutusV3.PlutusV3 {
  const code = spendValidator(blueprint("payment-v2.plutus.json"), "vested_pay.vested_pay.spend").compiledCode;
  const applied = UPLC.applyParamsToScript(code, [
    Data.int(BigInt(deployment.requiredAdmins)),
    Data.list(deployment.adminVkeys.map(vk => Data.bytearray(vk))),
    Data.int(BigInt(deployment.cooldownPeriod)),
  ]);
  // applyParamsToScript returns the script double-CBOR wrapped; PlutusV3 takes the single-wrapped bytes.
  const bytes = CBOR.fromCBORHex(applied);
  if (!(bytes instanceof Uint8Array)) throw new Error("Unexpected applied-script encoding");
  return new PlutusV3.PlutusV3({ bytes });
}

/** Registry V2 minting policy (unparameterised). */
export function registryScript(): PlutusV3.PlutusV3 {
  const v = blueprint("registry-v2.plutus.json").validators.find(x => x.title.endsWith(".mint"));
  if (!v) throw new Error("Registry mint validator not found");
  return new PlutusV3.PlutusV3({ bytes: Buffer.from(v.compiledCode, "hex") });
}

export const scriptHash = (script: PlutusV3.PlutusV3) => ScriptHash.toHex(ScriptHash.fromScript(script));

/** Throws unless the vendored blueprints hash to the canonical escrow + registry. */
export function assertCanonicalContracts() {
  const escrow = scriptHash(paymentScript());
  const expectedEscrow = masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT);
  const registry = scriptHash(registryScript());
  if (escrow !== expectedEscrow) throw new Error(`vested_pay hash ${escrow} != canonical ${expectedEscrow}`);
  if (registry !== REGISTRY_POLICY_ID) throw new Error(`registry policy ${registry} != canonical ${REGISTRY_POLICY_ID}`);
  return { escrowScriptHash: escrow, registryPolicyId: registry };
}