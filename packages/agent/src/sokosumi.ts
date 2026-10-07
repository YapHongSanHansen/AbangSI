/**
 * Sokosumi Core client + ReelForge coworker runtime.
 *
 * A Sokosumi Coworker is a vendor-owned actor; its runtime (this module) polls
 * Core for Tasks assigned to it using a `coworker_*` API key (Bearer, no
 * user-context header). Per paid Task:
 *   1. claim:   POST /v1/tasks/{id}/events {status: RUNNING}
 *   2. charge:  POST /v1/tasks/{id}/events {comment, masumiPayment} with terms ReelForge signed
 *               → Core debits workspace credits; Sokosumi's Masumi node locks tUSDM in vested_pay
 *   3. work:    the settlement watcher sees FundsLocked, generates the video, SubmitResult on chain
 *   4. finish:  POST /v1/tasks/{id}/events {status: COMPLETED, comment: <exact result>}
 *   5. collect: after unlock_time the collector withdraws (vested_pay Withdraw)
 */
import { optional } from "./config.js";
import { ESCROW_ADDRESS, REGISTRY_POLICY_ID, TUSDM_UNIT } from "./constants.js";
import { inputHash, issueTerms, newPurchaserNonce, type SignData } from "./masumi.js";
import { big, store, type Job } from "./store.js";
import { parseVideoInput } from "./video.js";

export const SOKOSUMI_API = optional("SOKOSUMI_API_URL", "https://api.preprod.sokosumi.com").replace(/\/+$/, "");

export async function core<T = any>(token: string, method: string, path: string, body?: unknown, orgSlug?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (orgSlug) headers["X-Organization-Slug"] = orgSlug;
  const r = await fetch(`${SOKOSUMI_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const msg = json?.error?.message ?? json?.message ?? json?.error ?? text.slice(0, 300);
    const err = new Error(`Sokosumi ${method} ${path.split("?")[0]} → ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`) as Error & { status?: number; body?: unknown };
    err.status = r.status; err.body = json;
    throw err;
  }
  return json as T;
}

const list = (body: any): any[] => (Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.tasks) ? body.data.tasks : Array.isArray(body) ? body : []);

/** Extracts the user's request from a Task (Core appends briefing links after a separator). */
function taskPrompt(task: { name?: string | null; description?: string | null }) {
  const desc = (task.description ?? "").split(/\n-{3,}\n|\n#{1,3} (Design|Project|Context)/)[0].trim();
  return (desc || task.name || "").slice(0, 1000);
}

export function startCoworkerRuntime(opts: { agentIdentifier: string; sellerAddress: string; sign: SignData; priceUnits: bigint }) {
  const key = optional("SOKOSUMI_COWORKER_API_KEY");
  const coworkerId = optional("SOKOSUMI_COWORKER_ID");
  if (!key || !coworkerId) { console.log("[coworker] SOKOSUMI_COWORKER_API_KEY / SOKOSUMI_COWORKER_ID not set — runtime disabled (pnpm sokosumi setup)"); return; }
  const paid = optional("SOKOSUMI_PAID", "1") !== "0";
  const busy = new Set<string>();

  async function event(taskId: string, body: Record<string, unknown>) {
    return core(key, "POST", `/v1/tasks/${encodeURIComponent(taskId)}/events`, body);
  }

  async function pickUp(task: any) {
    const taskId = String(task.id);
    if (busy.has(taskId) || store.find(j => j.sokosumiTaskId === taskId)) return;
    busy.add(taskId);
    try {
      const prompt = taskPrompt(task);
      const parsed = parseVideoInput({ prompt, aspect_ratio: /16:9|landscape|youtube/i.test(prompt) ? "16:9" : /1:1|square/i.test(prompt) ? "1:1" : "9:16" });
      await event(taskId, { status: "RUNNING", comment: "ReelForge picked up this Task." });
      if (typeof parsed === "string") { await event(taskId, { status: "FAILED", comment: `ReelForge needs a video prompt: ${parsed}` }); return; }
      const nonce = newPurchaserNonce();
      // Core does not recompute the Task input hash; ReelForge commits to the Task itself (MIP-004 form).
      const hash = inputHash(nonce, { taskId, name: task.name ?? "", description: task.description ?? null });
      if (!paid) {
        const job = store.create({ channel: "sokosumi", input: parsed, nonce, inputHash: hash, sokosumiTaskId: taskId, status: "running" });
        store.update(job.id, {}, `Sokosumi task ${taskId} (unpaid rehearsal)`);
        return; // unpaid path is driven by runUnpaid()
      }
      const terms = await issueTerms({
        identifierFromPurchaser: nonce, inputHash: hash, agentIdentifier: opts.agentIdentifier, sellerAddress: opts.sellerAddress,
        funds: [{ amount: opts.priceUnits.toString(), unit: TUSDM_UNIT }], sign: opts.sign,
      });
      const job = store.create({
        channel: "sokosumi", input: parsed, nonce, inputHash: hash, sokosumiTaskId: taskId,
        blockchainIdentifier: terms.blockchainIdentifier, agentIdentifier: opts.agentIdentifier, sellerVKey: terms.sellerVKey,
        expected: big({
          sellerAddress: opts.sellerAddress, referenceKey: terms.referenceKey, referenceSignature: terms.referenceSignature,
          sellerNonce: terms.sellerNonce, buyerNonce: nonce, agentIdentifier: opts.agentIdentifier, inputHash: hash,
          payByTime: String(terms.payByTime), submitResultTime: String(terms.submitResultTime), unlockTime: String(terms.unlockTime),
          externalDisputeUnlockTime: String(terms.externalDisputeUnlockTime), unit: TUSDM_UNIT, amount: opts.priceUnits.toString(),
        }),
      });
      const masumiPayment = {
        blockchainIdentifier: terms.blockchainIdentifier, identifierFromPurchaser: nonce, agentIdentifier: opts.agentIdentifier,
        sellerVkey: terms.sellerVKey, inputHash: hash,
        payByTime: String(terms.payByTime), submitResultTime: String(terms.submitResultTime),
        unlockTime: String(terms.unlockTime), externalDisputeUnlockTime: String(terms.externalDisputeUnlockTime),
        Amounts: terms.RequestedFunds, paymentSourceType: terms.paymentSourceType, supportedPaymentSourceIndex: terms.supportedPaymentSourceIndex,
        PaymentSource: { network: "Preprod", policyId: REGISTRY_POLICY_ID, smartContractAddress: ESCROW_ADDRESS },
      };
      const price = (Number(opts.priceUnits) / 1e6).toFixed(2);
      const r = await event(taskId, { comment: `Payment requested: ${price} tUSDM into Masumi escrow (vested_pay). The reel is generated as soon as the funds are locked on Cardano preprod.`, masumiPayment });
      store.update(job.id, {}, `masumiPayment posted to Sokosumi task ${taskId} (event ${r?.data?.id ?? "?"})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[coworker] task ${taskId}: ${msg}`);
      if ((error as { status?: number }).status === 422) await event(taskId, { status: "FAILED", comment: `ReelForge could not start: ${msg.slice(0, 300)}` }).catch(() => {});
    } finally { busy.delete(taskId); }
  }

  /** Reports finished/failed jobs back to their Sokosumi Task (once). */
  async function report(job: Job) {
    if (!job.sokosumiTaskId || job.log.some(l => l.includes("reported to Sokosumi"))) return;
    if (job.status === "completed" && job.result && job.resultTx && (job.resultConfirmed || job.resultTx === "unpaid")) {
      await event(job.sokosumiTaskId, { status: "COMPLETED", comment: job.result });
      store.update(job.id, {}, `reported to Sokosumi (COMPLETED); result hash ${job.resultHash} on chain in ${job.resultTx}`);
    } else if (job.status === "failed") {
      await event(job.sokosumiTaskId, { status: "FAILED", comment: `ReelForge failed: ${(job.error ?? "unknown").slice(0, 500)}` });
      store.update(job.id, {}, "reported to Sokosumi (FAILED)");
    }
  }

  /** Execution-only rehearsal (SOKOSUMI_PAID=0): no escrow, just the video. */
  async function runUnpaid(job: Job) {
    const { generateVideo, resultText } = await import("./video.js");
    store.update(job.id, { status: "running" }, "generating (unpaid)");
    try {
      const v = await generateVideo(job.input, Date.now() + 15 * 60_000);
      const result = resultText(v.videoUrl, v.generationId, job.input);
      store.update(job.id, { result, videoUrl: v.videoUrl, generationId: v.generationId, resultTx: "unpaid", status: "completed" }, `video ready ${v.videoUrl}`);
    } catch (e) { store.update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) }, "generation failed"); }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const body = await core(key, "GET", `/v1/tasks?coworkerId=${encodeURIComponent(coworkerId)}&status=READY&take=20`);
      for (const t of list(body)) await pickUp(t);
      for (const job of store.all().filter(j => j.channel === "sokosumi")) {
        if (!paid && job.status === "running" && !job.result && !job.log.some(l => l.includes("generating (unpaid)"))) void runUnpaid(job);
        await report(job).catch(e => console.warn(`[coworker] report ${job.sokosumiTaskId}: ${e instanceof Error ? e.message : e}`));
      }
    } catch (error) { console.warn(`[coworker] poll: ${error instanceof Error ? error.message : error}`); }
    finally { ticking = false; }
  }
  setInterval(() => { void tick(); }, 15_000);
  void tick();
  console.log(`[coworker] runtime polling Sokosumi as coworker ${coworkerId} (${paid ? "paid via masumiPayment" : "unpaid rehearsal"})`);
}