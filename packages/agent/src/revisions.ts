/**
 * Revisions: one hire (one escrow payment) covers up to MAX_ITERATIONS_PER_HIRE
 * generations — the first delivery plus revisions on the same Task. Beyond that
 * the buyer must hire ReelForge again (new Task / new payment).
 *
 * The on-chain result hash commits to the first delivery; every revision gets
 * its own MIP-004-style hash recorded on the job. Revisions keep the paid specs
 * (length + resolution from the quote), so a revision can't upgrade the order.
 */
import { optional } from "./config.js";
import { resultHash } from "./masumi.js";
import { store, type Iteration, type Job } from "./store.js";
import { generateVideo, resultText } from "./video.js";

export const MAX_ITERATIONS = Math.max(1, Number(optional("MAX_ITERATIONS_PER_HIRE", "5")) || 5);
const running = new Set<string>();

export function iterations(job: Job): Iteration[] {
  if (job.iterations?.length) return job.iterations;
  return job.result ? [{ n: 1, at: job.updatedAt, prompt: job.input.prompt, generationId: job.generationId, videoUrl: job.videoUrl, result: job.result, resultHash: job.resultHash }] : [];
}
export const revisionsLeft = (job: Job) => Math.max(0, MAX_ITERATIONS - iterations(job).length);

export type ReviseOutcome =
  | { ok: true; iteration: Iteration; left: number }
  | { ok: false; reason: "not_delivered" | "limit_reached" | "busy" | "failed"; message: string };

export async function revise(jobId: string, instructions: string): Promise<ReviseOutcome> {
  const job = store.get(jobId);
  if (!job || job.status !== "completed" || !job.resultConfirmed) return { ok: false, reason: "not_delivered", message: "The first delivery of this hire is not complete yet." };
  const done = iterations(job);
  if (done.length >= MAX_ITERATIONS) {
    return { ok: false, reason: "limit_reached", message: `This hire included ${MAX_ITERATIONS} generations (the first reel + ${MAX_ITERATIONS - 1} revisions) and they are all used. Please hire ReelForge again with a new Task for more changes.` };
  }
  if (running.has(jobId)) return { ok: false, reason: "busy", message: "A revision for this hire is already being generated." };
  running.add(jobId);
  const n = done.length + 1;
  const clean = instructions.replace(/\s+/g, " ").trim().slice(0, 500);
  const prompt = (clean ? `${job.input.prompt}. Revision request: ${clean}` : job.input.prompt).slice(0, 1000);
  try {
    store.update(jobId, { iterations: done }, `revision ${n}/${MAX_ITERATIONS} started${clean ? `: ${clean.slice(0, 120)}` : ""}`);
    // Same paid length/resolution as the original order.
    const video = await generateVideo({ ...job.input, prompt }, Date.now() + 15 * 60_000);
    const result = `${resultText(video.videoUrl, video.generationId, { ...job.input, prompt })} | revision ${n}/${MAX_ITERATIONS}`;
    const it: Iteration = { n, at: Date.now(), instructions: clean, prompt, generationId: video.generationId, videoUrl: video.videoUrl, result, resultHash: resultHash(job.nonce, result) };
    store.update(jobId, { iterations: [...done, it] }, `revision ${n}/${MAX_ITERATIONS} ready ${video.videoUrl}`);
    return { ok: true, iteration: it, left: MAX_ITERATIONS - n };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.update(jobId, {}, `revision ${n} failed: ${message}`);
    return { ok: false, reason: "failed", message: `Revision failed (not counted): ${message.slice(0, 200)}` };
  } finally { running.delete(jobId); }
}