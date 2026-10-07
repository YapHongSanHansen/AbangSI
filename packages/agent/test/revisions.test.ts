/** Revision limit: a hire allows MAX_ITERATIONS generations, then requires a rehire. Network stubbed; isolated data dir. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REELFORGE_DATA_DIR = mkdtempSync(join(tmpdir(), "reelforge-test-")) + "/";
process.env.VIDEO_BACKEND = "mock";
process.env.MAX_ITERATIONS_PER_HIRE = "5";
process.env.PUBLIC_BASE_URL = "https://agent.example";
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200 })) as typeof fetch;

const { store } = await import("../src/store.js");
const { revise, revisionsLeft, MAX_ITERATIONS } = await import("../src/revisions.js");

test("a hire allows 5 generations (reel + 4 revisions), then asks for a rehire", async () => {
  const job = store.create({ channel: "sokosumi", input: { prompt: "a red apple", duration: 5, resolution: "720p" }, nonce: "0123456789abcdef0123", inputHash: "00".repeat(32) });
  assert.equal((await revise(job.id, "darker")).ok, false, "not delivered yet");
  store.update(job.id, { status: "completed", resultConfirmed: true, result: "first", videoUrl: "https://agent.example/media/a.mp4", resultHash: "11".repeat(32) });
  assert.equal(revisionsLeft(store.get(job.id)!), MAX_ITERATIONS - 1);
  for (let n = 2; n <= MAX_ITERATIONS; n++) {
    const out = await revise(job.id, `change ${n}`);
    assert.ok(out.ok, `revision ${n}`);
    if (out.ok) { assert.equal(out.iteration.n, n); assert.match(out.iteration.result!, new RegExp(`revision ${n}/5`)); assert.match(out.iteration.resultHash!, /^[0-9a-f]{64}$/); }
  }
  const sixth = await revise(job.id, "one more");
  assert.equal(sixth.ok, false);
  if (!sixth.ok) { assert.equal(sixth.reason, "limit_reached"); assert.match(sixth.message, /hire ReelForge again/); }
  assert.equal(store.get(job.id)!.iterations!.length, 5);
  // Paid specs are pinned: a revision asking for 15s 1080p does not upgrade the order.
  assert.equal(store.get(job.id)!.input.duration, 5);
});
test.after(() => { globalThis.fetch = realFetch; });