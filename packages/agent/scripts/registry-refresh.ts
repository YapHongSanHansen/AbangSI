/**
 * Asks the Masumi registry to re-run ReelForge's health check now (POST /registry-entry-refresh).
 * Run after `update-registry` once the agent serves the new MASUMI_AGENT_IDENTIFIER on /availability;
 * otherwise the registry keeps the entry "Invalid" from its first (mismatched) check.
 */
import { agentIdentifier } from "../src/config.js";
const id = agentIdentifier();
if (!id) throw new Error("MASUMI_AGENT_IDENTIFIER not set");
const r = await fetch("https://registry.masumi.network/api/v1/registry-entry-refresh/", {
  method: "POST", headers: { token: "public-test-key-masumi-registry-c23f3d21", "Content-Type": "application/json" },
  body: JSON.stringify({ network: "Preprod", agentIdentifier: id }),
});
const e = ((await r.json()) as any)?.data?.entry;
console.log(r.status, e ? `status=${e.status} api=${e.apiBaseUrl} lastUptimeCheck=${e.lastUptimeCheck}` : "no entry");