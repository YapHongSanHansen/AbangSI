/**
 * Files as prompt input: documents (PDF, DOCX, TXT, MD, CSV, JSON) are read and,
 * together with the buyer's written instructions and any reference images, turned
 * into one concrete video prompt. Results are memoised by the exact inputs so a
 * quote (402 / start_job / Sokosumi) and the paid generation always use the same prompt.
 */
import { createHash } from "node:crypto";
import { optional } from "./config.js";

export const DOC_EXT = /\.(pdf|docx|txt|md|markdown|csv|json)(\?|#|$)/i;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CHARS_PER_DOC = 6000;
const MAX_CHARS_TOTAL = 15000;

export interface SourceFile { name: string; kind: string; chars: number }
export interface DerivedPrompt { prompt: string; sources: SourceFile[]; via: "openai" | "excerpt" }

const nameOf = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? "file");

export async function fileText(url: string): Promise<{ name: string; kind: string; text: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`could not download ${nameOf(url)} (${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) throw new Error(`${nameOf(url)} is larger than 15 MB`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  let text: string;
  if (ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    text = (await extractText(pdf, { mergePages: true })).text as string;
  } else if (ext === "docx") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: Buffer.from(buf) })).value;
  } else {
    text = new TextDecoder().decode(buf);
  }
  return { name: nameOf(url), kind: ext || "text", text: text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS_PER_DOC) };
}

const cache = new Map<string, Promise<DerivedPrompt>>();

/** Builds a video prompt from written instructions + document contents (+ images as visual references). */
export function promptFromFiles(instructions: string, docUrls: string[], imageUrls: string[] = []): Promise<DerivedPrompt> {
  const key = createHash("sha256").update(JSON.stringify([instructions, docUrls, imageUrls])).digest("hex");
  let p = cache.get(key);
  if (!p) {
    p = derive(instructions, docUrls, imageUrls);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return p;
}

async function derive(instructions: string, docUrls: string[], imageUrls: string[]): Promise<DerivedPrompt> {
  const docs = await Promise.all(docUrls.slice(0, 5).map(fileText));
  const sources = docs.map(d => ({ name: d.name, kind: d.kind, chars: d.text.length }));
  if (!docs.some(d => d.text)) throw new Error("the attached files contain no readable text");
  let budget = MAX_CHARS_TOTAL;
  const corpus = docs.map(d => { const t = d.text.slice(0, Math.max(0, budget)); budget -= t.length; return `### ${d.name}\n${t}`; }).join("\n\n");

  const key = optional("OPENAI_API_KEY");
  if (key) {
    try {
      const content: unknown[] = [{ type: "text", text: `Buyer instructions:\n${instructions || "(none — make the best short promotional reel from the files)"}\n\nAttached documents:\n${corpus}${imageUrls.length ? `\n\n${imageUrls.length} reference image(s) are attached below.` : ""}` }];
      for (const url of imageUrls.slice(0, 4)) content.push({ type: "image_url", image_url: { url } });
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: optional("OPENAI_MODEL", "gpt-4o-mini"), temperature: 0.2, max_tokens: 400,
          messages: [
            { role: "system", content: "You write prompts for an AI text-to-video model that makes one short reel. Using the buyer's instructions and the facts in their documents (and reference images if given), write ONE paragraph of at most 900 characters describing exactly what should be on screen: subject, setting, action, camera movement, lighting, style and mood. Use concrete visual details from the documents (product names, colours, places, key message). If the reel should show a short on-screen headline, include it in quotes. Plain text only: no markdown, no lists, no preamble." },
            { role: "user", content },
          ],
        }),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}`);
      const prompt = ((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message?.content?.replace(/\s+/g, " ").trim();
      if (prompt) return { prompt: prompt.slice(0, 1000), sources, via: "openai" };
    } catch (e) { console.warn(`[files] prompt writer unavailable, using excerpt: ${e instanceof Error ? e.message : e}`); }
  }
  // Fallback: instructions + the opening of the first documents.
  const excerpt = docs.map(d => d.text).join(" ").slice(0, 700);
  return { prompt: `${instructions ? `${instructions}. ` : ""}Based on: ${excerpt}`.slice(0, 1000), sources, via: "excerpt" };
}