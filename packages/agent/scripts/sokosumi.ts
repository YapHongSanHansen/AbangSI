/**
 * Sokosumi operations for the ReelForge coworker (user API key, TOKEN2049 org only).
 *   pnpm sokosumi status            account, vendor, coworker, access, credits
 *   pnpm sokosumi setup             create/reuse ReelForge coworker under your Vendor, request access
 *                                   (Personal = instant, TOKEN2049 = PENDING until an event admin approves),
 *                                   create a runtime key → .env (never printed)
 *   pnpm sokosumi task [org] "<prompt>"   create a READY Task assigned to ReelForge (personal by default)
 *   pnpm sokosumi receipt <taskId>  Core payment receipt for a Task (coworker key)
 *   pnpm sokosumi events <taskId>   Task event log
 */
import { readFileSync, writeFileSync } from "node:fs";
import { optional, publicUrl, required, ROOT_ENV } from "../src/config.js";
import { core } from "../src/sokosumi.js";

const userKey = required("SOKOSUMI_API_KEY");
const ORG_ID = required("SOKOSUMI_ORGANIZATION_ID");
const ORG_SLUG = required("SOKOSUMI_ORGANIZATION_SLUG");
const NAME = optional("AGENT_NAME", "ReelForge");
const data = (b: any) => b?.data ?? b;

function setEnv(name: string, value: string) {
  const env = readFileSync(ROOT_ENV, "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(ROOT_ENV, re.test(env) ? env.replace(re, `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`);
  process.env[name] = value;
}

async function personalWorkspaceId() {
  const ws = data(await core(userKey, "GET", "/v1/users/me/workspaces"));
  return (ws.workspaces as any[]).find(w => w.kind === "personal")?.id as string;
}
async function vendor() {
  const v = data(await core(userKey, "GET", "/v1/vendors/me"));
  const one = Array.isArray(v) ? v[0] : v?.vendors?.[0] ?? v;
  if (!one?.id) throw new Error("No Vendor administered by this account");
  return one as { id: string; name: string; slug: string };
}
async function findCoworker() {
  const id = optional("SOKOSUMI_COWORKER_ID");
  if (id) return data(await core(userKey, "GET", `/v1/coworkers/${id}`));
  const all = data(await core(userKey, "GET", "/v1/coworkers?scope=owned"));
  return (Array.isArray(all) ? all : all?.coworkers ?? []).find((c: any) => c.name === NAME) ?? null;
}
async function access(id: string) {
  const rows = data(await core(userKey, "GET", `/v1/coworkers/${id}/workspace-access`));
  return (Array.isArray(rows) ? rows : rows?.items ?? []).map((r: any) => `${r.workspaceDisplayName ?? r.workspaceId}: ${r.status}`);
}

const [cmd = "status", ...args] = process.argv.slice(2);

if (cmd === "status") {
  const me = data(await core(userKey, "GET", "/v1/users/me"));
  const v = await vendor().catch(e => ({ error: e.message }));
  const c = await findCoworker().catch(() => null);
  console.log(`user     ${me.name} (${me.id})`);
  console.log(`vendor   ${JSON.stringify(v)}`);
  console.log(`coworker ${c ? `${c.name} ${c.id} slug=${c.slug} capabilities=${c.capabilities}` : "(none)"}`);
  if (c) console.log(`access   ${(await access(c.id)).join(" | ")}`);
  console.log(`runtime key in .env: ${optional("SOKOSUMI_COWORKER_API_KEY") ? "yes" : "no"}`);
} else if (cmd === "setup") {
  const v = await vendor();
  let c = await findCoworker();
  if (!c) {
    c = data(await core(userKey, "POST", "/v1/coworkers", {
      vendorId: v.id, name: NAME, capabilities: ["tasks"],
      caption: "Prompt → AI video reel, paid on Cardano",
      description: "ReelForge turns a short prompt into a vertical AI video reel (Higgsfield). Assign a Task with your prompt; ReelForge charges 1 tUSDM via Masumi escrow on Cardano preprod, writes the result hash on chain and returns a playable MP4.",
      url: publicUrl(),
      metadata: { channels: {} },
    }));
    console.log(`created coworker ${c.name} ${c.id}`);
  } else console.log(`reusing coworker ${c.name} ${c.id}`);
  setEnv("SOKOSUMI_COWORKER_ID", c.id);
  setEnv("SOKOSUMI_VENDOR_ID", v.id);
  for (const body of [{ workspaceId: await personalWorkspaceId() }, { organizationId: ORG_ID }]) {
    try { const r = data(await core(userKey, "POST", `/v1/coworkers/${c.id}/workspace-access`, body)); console.log(`access ${r.workspaceDisplayName ?? JSON.stringify(body)}: ${r.status}`); }
    catch (e) { console.warn(`access ${JSON.stringify(body)}: ${(e as Error).message}`); }
  }
  if (!optional("SOKOSUMI_COWORKER_API_KEY")) {
    const k = data(await core(userKey, "POST", `/v1/coworkers/${c.id}/api-keys`, { name: "reelforge-runtime", expiresAt: null }));
    const token = k?.token ?? k?.apiKey?.token;
    if (typeof token !== "string" || !token.startsWith("coworker_")) throw new Error("API key response had no coworker_ token");
    setEnv("SOKOSUMI_COWORKER_API_KEY", token);
    console.log("runtime key created and saved to .env (not printed)");
  } else console.log("runtime key already in .env");
} else if (cmd === "task") {
  const org = args[0] === "org";
  const prompt = (org ? args.slice(1) : args).join(" ") || "A neon-lit Singapore skyline at night, slow cinematic drone push-in, 9:16";
  const id = required("SOKOSUMI_COWORKER_ID");
  const t = data(await core(userKey, "POST", "/v1/tasks", { name: `ReelForge: ${prompt.slice(0, 60)}`, description: prompt, coworkerId: id, status: "READY" }, org ? ORG_SLUG : undefined));
  console.log(`task ${t.id} status=${t.status} workspace=${org ? ORG_SLUG : "personal"}`);
} else if (cmd === "receipt") {
  console.log(JSON.stringify(data(await core(required("SOKOSUMI_COWORKER_API_KEY"), "GET", `/v1/tasks/${args[0]}/receipt`)), null, 2));
} else if (cmd === "events") {
  const ev = data(await core(userKey, "GET", `/v1/tasks/${args[0]}/events?limit=100`));
  for (const e of Array.isArray(ev) ? ev : []) console.log(`${e.createdAt} ${e.actor?.type ?? ""} ${e.status ?? ""} ${(e.comment ?? "").slice(0, 160)}`);
} else throw new Error(`unknown command ${cmd}`);