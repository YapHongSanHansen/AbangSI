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
import { quote, quoteSummary } from "./pricing.js";
import { MAX_ITERATIONS, revise, revisionsLeft } from "./revisions.js";

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

export function startCoworkerRuntime(opts: { agentIdentifier: string; sellerAddress: string; sign: SignData }) {
  const key = optional("SOKOSUMI_COWORKER_API_KEY");
  const coworkerId = optional("SOKOSUMI_COWORKER_ID");
  if (!key || !coworkerId) { console.log("[coworker] SOKOSUMI_COWORKER_API_KEY / SOKOSUMI_COWORKER_ID not set — runtime disabled (pnpm sokosumi setup)"); return; }
  const paid = optional("SOKOSUMI_PAID", "1") !== "0";
  const busy = new Set<string>();

  async function event(taskId: string, body: Record<string, unknown>) {
    return core(key, "POST", `/v1/tasks/${encodeURIComponent(taskId)}/events`, body);
  }
  /** Status changes on an already-completed Task may be refused; fall back to a plain comment. */
  async function statusEvent(taskId: string, body: { status: string; comment: string }) {
    try { return await event(taskId, body); }
    catch (e) { if ((e as { status?: number }).status && (e as { status: number }).status < 500) return event(taskId, { comment: body.comment }); throw e; }
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
      const q = quote(parsed);
      const input = { ...parsed, duration: q.durationSeconds, resolution: q.resolution };
      const price = { tusdm: q.tusdm, ada: q.ada, summary: quoteSummary(q) };
      const nonce = newPurchaserNonce();
      // Core does not recompute the Task input hash; ReelForge commits to the Task itself (MIP-004 form).
      const hash = inputHash(nonce, { taskId, name: task.name ?? "", description: task.description ?? null });
      if (!paid) {
        const job = store.create({ channel: "sokosumi", input, price, nonce, inputHash: hash, sokosumiTaskId: taskId, status: "running" });
        store.update(job.id, {}, `Sokosumi task ${taskId} (unpaid rehearsal)`);
        return; // unpaid path is driven by runUnpaid()
      }
      const terms = await issueTerms({
        identifierFromPurchaser: nonce, inputHash: hash, agentIdentifier: opts.agentIdentifier, sellerAddress: opts.sellerAddress,
        funds: [{ amount: q.tusdmUnits.toString(), unit: TUSDM_UNIT }], sign: opts.sign,
      });
      const job = store.create({
        channel: "sokosumi", input, price, nonce, inputHash: hash, sokosumiTaskId: taskId,
        blockchainIdentifier: terms.blockchainIdentifier, agentIdentifier: opts.agentIdentifier, sellerVKey: terms.sellerVKey,
        expected: big({
          sellerAddress: opts.sellerAddress, referenceKey: terms.referenceKey, referenceSignature: terms.referenceSignature,
          sellerNonce: terms.sellerNonce, buyerNonce: nonce, agentIdentifier: opts.agentIdentifier, inputHash: hash,
          payByTime: String(terms.payByTime), submitResultTime: String(terms.submitResultTime), unlockTime: String(terms.unlockTime),
          externalDisputeUnlockTime: String(terms.externalDisputeUnlockTime), unit: TUSDM_UNIT, amount: q.tusdmUnits.toString(),
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
      const r = await event(taskId, { comment: `Quote: ${q.tusdm} tUSDM for a ${q.durationSeconds}s ${q.resolution} reel (${q.complexity.tier} prompt). Breakdown: ${q.breakdown.join("; ")}. Paid into Masumi escrow (vested_pay) on Cardano preprod; includes up to ${MAX_ITERATIONS} generations (the reel + ${MAX_ITERATIONS - 1} revisions). The reel is generated as soon as the funds are locked.`, masumiPayment });
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
      const r = await event(job.sokosumiTaskId, { status: "COMPLETED", comment: `${job.result}\n\nNeed changes? Comment on this Task with what to change (or move it back to Ready). This hire includes ${revisionsLeft(job)} more revision${revisionsLeft(job) === 1 ? "" : "s"}.` });
      store.update(job.id, { sokosumiSeenAt: r?.data?.createdAt ?? new Date().toISOString() }, `reported to Sokosumi (COMPLETED); result hash ${job.resultHash} on chain in ${job.resultTx}`);
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

  /** New buyer comments (or a move back to READY) on a delivered Task = a revision request. */
  const revising = new Set<string>();
  async function checkRevisions(job: Job) {
    if (!job.sokosumiTaskId || !job.sokosumiSeenAt || revising.has(job.id)) return;
    if (Date.now() - job.updatedAt > 7 * 24 * 3600_000) return;
    const body = await core(key, "GET", `/v1/tasks/${encodeURIComponent(job.sokosumiTaskId)}/events?limit=100`);
    const events = list(body).filter((e: any) => e.createdAt > job.sokosumiSeenAt! && e.actor?.type !== "coworker");
    const request = events.filter((e: any) => (typeof e.comment === "string" && e.comment.trim()) || e.status === "READY");
    if (!request.length) { if (events.length) store.update(job.id, { sokosumiSeenAt: events.at(-1).createdAt }); return; }
    const last = request.at(-1);
    const instructions = request.map((e: any) => (e.comment ?? "").trim()).filter(Boolean).join(" ");
    store.update(job.id, { sokosumiSeenAt: last.createdAt });
    revising.add(job.id);
    try {
      const taskId = job.sokosumiTaskId;
      if (revisionsLeft(job) <= 0) {
        await statusEvent(taskId, { status: "COMPLETED", comment: `This hire included ${MAX_ITERATIONS} generations (the reel + ${MAX_ITERATIONS - 1} revisions) and all are used. To keep iterating, please hire ReelForge again with a new Task (a new quote and payment).` });
        store.update(job.id, {}, "revision refused: limit reached (rehire required)");
        return;
      }
      const n = MAX_ITERATIONS - revisionsLeft(job) + 1;
      await statusEvent(taskId, { status: "RUNNING", comment: `Revision ${n}/${MAX_ITERATIONS} started${instructions ? `: "${instructions.slice(0, 200)}"` : " (new variation)"}.` });
      const out = await revise(job.id, instructions);
      const fresh = store.get(job.id)!;
      if (out.ok) {
        const r = await statusEvent(taskId, { status: "COMPLETED", comment: `${out.iteration.result}\n\nRevision ${out.iteration.n}/${MAX_ITERATIONS} delivered — ${out.left} revision${out.left === 1 ? "" : "s"} left on this hire.${out.left === 0 ? " After this, a new Task (rehire) is needed for more changes." : ""}` });
        store.update(fresh.id, { sokosumiSeenAt: r?.data?.createdAt ?? new Date().toISOString() });
      } else {
        const r = await statusEvent(taskId, { status: "COMPLETED", comment: out.message });
        store.update(fresh.id, { sokosumiSeenAt: r?.data?.createdAt ?? new Date().toISOString() });
      }
    } finally { revising.delete(job.id); }
  }

  let ticking = false;
  let tickCount = 0;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const body = await core(key, "GET", `/v1/tasks?coworkerId=${encodeURIComponent(coworkerId)}&status=READY&take=20`);
      for (const t of list(body)) await pickUp(t);
      for (const job of store.all().filter(j => j.channel === "sokosumi")) {
        if (!paid && job.status === "running" && !job.result && !job.log.some(l => l.includes("generating (unpaid)"))) void runUnpaid(job);
        await report(job).catch(e => console.warn(`[coworker] report ${job.sokosumiTaskId}: ${e instanceof Error ? e.message : e}`));
        if (tickCount % 2 === 0 && job.status === "completed" && job.resultConfirmed) void checkRevisions(job).catch(e => console.warn(`[coworker] revisions ${job.sokosumiTaskId}: ${e instanceof Error ? e.message : e}`));
      }
    } catch (error) { console.warn(`[coworker] poll: ${error instanceof Error ? error.message : error}`); }
    finally { ticking = false; tickCount++; }
  }
  setInterval(() => { void tick(); }, 15_000);
  void tick();
  console.log(`[coworker] runtime polling Sokosumi as coworker ${coworkerId} (${paid ? "paid via masumiPayment" : "unpaid rehearsal"})`);
}