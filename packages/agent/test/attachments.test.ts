import test from "node:test";
import assert from "node:assert/strict";
import { extractAttachments } from "../src/attachments.js";
import { quote } from "../src/pricing.js";

const desc = "[content.png\n](https://blob.example/users/u/content-x.png)\n[WhatsApp Image (1).jpeg](https://blob.example/users/u/wa-1.jpeg)\n[clip.mp4](https://blob.example/users/u/clip-2.mp4)\nReplace the man with the person in reference photo 1.\nKeep the camera move.";
test("attachments are split from the written prompt", () => {
  const a = extractAttachments(desc);
  assert.deepEqual(a.images, ["https://blob.example/users/u/content-x.png", "https://blob.example/users/u/wa-1.jpeg"]);
  assert.deepEqual(a.videos, ["https://blob.example/users/u/clip-2.mp4"]);
  assert.equal(a.text, "Replace the man with the person in reference photo 1. Keep the camera move.");
});
test("file links and line breaks do not inflate the quote", () => {
  assert.equal(quote({ prompt: desc }).tusdm, quote({ prompt: extractAttachments(desc).text }).tusdm);
  assert.equal(quote({ prompt: "A red apple\non a table\nin soft light" }).complexity.scenes, 1);
});