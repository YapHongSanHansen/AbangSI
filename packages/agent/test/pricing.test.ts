import test from "node:test";
import assert from "node:assert/strict";
import { complexity, quote, requestedSpecs } from "../src/pricing.js";

test("simple 5 s 720p reel stays at 1 tUSDM / 5 tADA", () => {
  const q = quote({ prompt: "A red apple on a wooden table" });
  assert.equal(q.tusdm, "1.00"); assert.equal(q.ada, "5.00"); assert.equal(q.tusdmUnits, 1_000_000n); assert.equal(q.complexity.tier, "simple");
});
test("length is read from the prompt and clamped", () => {
  assert.equal(requestedSpecs({ prompt: "a 10s clip of waves" }).durationSeconds, 10);
  assert.equal(requestedSpecs({ prompt: "a 60 seconds film" }).durationSeconds, 15);
  assert.equal(requestedSpecs({ prompt: "x", duration: 2 }).durationSeconds, 4);
  assert.equal(requestedSpecs({ prompt: "in 1080p please" }).resolution, "1080p");
});
test("longer, higher-res and more complex prompts cost more (monotonic)", () => {
  const simple = quote({ prompt: "A red apple on a wooden table" });
  const longer = quote({ prompt: "A red apple on a wooden table", duration: 10 });
  const hd = quote({ prompt: "A red apple on a wooden table", resolution: "1080p" });
  const complex = quote({ prompt: "Drone push-in over a neon city at night with rain and a crowd of dancers, then cut to a close-up portrait of a woman, then the TOKEN2049 logo appears in glowing text with fireworks" });
  assert.ok(longer.tusdmUnits > simple.tusdmUnits);
  assert.ok(hd.tusdmUnits > simple.tusdmUnits);
  assert.equal(complex.complexity.tier, "complex");
  assert.ok(complex.tusdmUnits > simple.tusdmUnits);
  assert.ok(complexity("A cat").score < complexity("A cat, then cut to a dog; then a drone orbit over neon rain").score);
});
test("x402 tADA price never drops below the 2 tADA min-UTxO-safe floor", () => {
  assert.ok(quote({ prompt: "a dot", resolution: "480p", duration: 4 }).lovelace >= 2_000_000n);
});