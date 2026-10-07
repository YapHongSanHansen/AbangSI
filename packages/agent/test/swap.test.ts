import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mvhdSeconds } from "../src/videoprobe.js";
import { quote } from "../src/pricing.js";

test("reads MP4 duration from mvhd", () => {
  const buf = readFileSync(new URL("../../web/server/assets/mock-generation.mp4", import.meta.url));
  const s = mvhdSeconds(new Uint8Array(buf))!;
  assert.ok(s > 4.5 && s < 5.5, `got ${s}`);
});
test("character swap is priced per second of the uploaded video, above text-to-video", () => {
  const text = quote({ prompt: "swap the people", duration: 5 });
  const swap = quote({ prompt: "swap the people", duration: 5, mode: "swap" });
  assert.equal(swap.mode, "swap");
  assert.ok(swap.tusdmUnits > text.tusdmUnits);
  assert.ok(quote({ prompt: "swap", duration: 10, mode: "swap" }).tusdmUnits > swap.tusdmUnits);
});