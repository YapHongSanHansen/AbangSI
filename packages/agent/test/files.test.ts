/** Files → text → prompt (network stubbed; OpenAI disabled so the deterministic excerpt path is tested). */
import test from "node:test";
import assert from "node:assert/strict";
process.env.OPENAI_API_KEY = "";
const docs: Record<string, string> = {
  "https://files.example/brief.md": "# Launch brief\nProduct: AquaPeak bottle, matte black. Message: Stay cold 24h. Setting: misty mountain lake at sunrise.",
  "https://files.example/specs.csv": "feature,value\ncapacity,750ml\ncolour,matte black",
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => docs[url] !== undefined ? new Response(docs[url]) : new Response("nope", { status: 404 })) as typeof fetch;
const { promptFromFiles, fileText } = await import("../src/files.js");
const { extractAttachments } = await import("../src/attachments.js");
const { resolveInput } = await import("../src/input.js");

test("documents are classified and read", async () => {
  const a = extractAttachments("[brief.md](https://files.example/brief.md) [s.csv](https://files.example/specs.csv) make a teaser");
  assert.deepEqual(a.documents, ["https://files.example/brief.md", "https://files.example/specs.csv"]);
  assert.match((await fileText("https://files.example/brief.md")).text, /AquaPeak/);
});
test("prompt is built from instructions + file contents, and memoised", async () => {
  const p1 = await promptFromFiles("make a 9:16 teaser", ["https://files.example/brief.md"]);
  assert.equal(p1.via, "excerpt");
  assert.match(p1.prompt, /make a 9:16 teaser/); assert.match(p1.prompt, /AquaPeak/);
  assert.equal(p1.sources[0].name, "brief.md");
  assert.equal(await promptFromFiles("make a 9:16 teaser", ["https://files.example/brief.md"]), p1); // same object → same quote
});
test("file-only requests resolve and are priced with a per-file surcharge", async () => {
  const r = await resolveInput({ prompt: "teaser", files: ["https://files.example/brief.md", "https://files.example/specs.csv"] });
  assert.ok(typeof r !== "string");
  if (typeof r !== "string") { assert.equal(r.input.source_files?.length, 2); assert.ok(r.quote.breakdown.some(b => /2 files read/.test(b))); }
});
test("unreadable files are reported, not charged", async () => {
  await assert.rejects(promptFromFiles("x", ["https://files.example/missing.pdf"]), /could not download/);
});
test.after(() => { globalThis.fetch = realFetch; });