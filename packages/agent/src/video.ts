/**
 * The ReelForge job: prompt → Higgsfield video → durable public copy.
 *
 * Higgsfield access goes through the shared `@reelforge/higgsfield` client
 * (credentials stay server-side). The finished MP4 is copied into
 * data/media/<sha256>.mp4 and served from this agent, because provider URLs can
 * expire; the original bytes are never modified.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { optional, publicUrl, videoBackend } from "./config.js";
import { DATA_DIR, type VideoInput } from "./store.js";

export const MEDIA_DIR = `${DATA_DIR}media/`;

export const INPUT_SCHEMA = {
  input_data: [
    {
      id: "prompt", type: "textarea", name: "Video prompt",
      data: { placeholder: "A neon-lit Singapore skyline at night, slow drone push-in, cinematic", description: "Describe the reel you want (max 1000 characters)." },
      validations: [{ validation: "min", value: "3" }, { validation: "max", value: "1000" }],
    },
    {
      id: "aspect_ratio", type: "option", name: "Aspect ratio",
      data: { values: ["9:16", "16:9", "1:1"], description: "9:16 for Reels/TikTok/Shorts" },
      validations: [{ validation: "min", value: "1" }, { validation: "max", value: "1" }],
    },
  ],
};

/** Accepts MIP-003 input_data in object form or Sokosumi option arrays/indices. */
export function parseVideoInput(raw: unknown): VideoInput | string {
  const d = (raw ?? {}) as Record<string, unknown>;
  const prompt = typeof d.prompt === "string" ? d.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 1000) return "input_data.prompt must be 3–1000 characters";
  const ratios = ["9:16", "16:9", "1:1"] as const;
  let ar: unknown = d.aspect_ratio;
  if (Array.isArray(ar)) ar = ar[0];
  if (typeof ar === "number") ar = ratios[ar];
  const aspect_ratio = (ratios as readonly unknown[]).includes(ar) ? (ar as VideoInput["aspect_ratio"]) : "9:16";
  return { prompt, aspect_ratio };
}

type Hf = {
  createVideo(o: { prompt: string; aspectRatio?: string; durationSeconds?: number; model?: string }): Promise<{ generationId: string }>;
  waitForVideo(id: string, o: { timeoutMs: number; pollMs: number }): Promise<{ status: string; videoUrl?: string; error?: string }>;
};
let hf: Hf | null | undefined;
async function higgsfield(): Promise<Hf | null> {
  if (hf !== undefined) return hf;
  try { hf = (await import("@reelforge/higgsfield" as string)) as Hf; }
  catch { hf = null; console.warn("[video] @reelforge/higgsfield not available — using mock backend"); }
  return hf;
}

const SAMPLE_MP4 = optional("MOCK_VIDEO_URL", "https://download.samplelib.com/mp4/sample-5s.mp4");

/** Runs one generation and returns a durable public URL to the MP4. */
export async function generateVideo(input: VideoInput, deadlineMs: number): Promise<{ generationId: string; videoUrl: string; sourceUrl: string }> {
  const client = videoBackend() === "mock" ? null : await higgsfield();
  let generationId = `mock-${Date.now()}`;
  let sourceUrl = SAMPLE_MP4;
  if (client) {
    const created = await client.createVideo({ prompt: input.prompt, aspectRatio: input.aspect_ratio, model: optional("HIGGSFIELD_MODEL") || undefined });
    generationId = created.generationId;
    const timeoutMs = Math.max(30_000, deadlineMs - Date.now());
    const done = await client.waitForVideo(generationId, { timeoutMs, pollMs: 5_000 });
    if (done.status !== "completed" || !done.videoUrl) throw new Error(`Higgsfield generation ${generationId} ${done.status}: ${done.error ?? "no video"}`);
    sourceUrl = done.videoUrl;
  }
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`video download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.mp4`;
  mkdirSync(MEDIA_DIR, { recursive: true });
  if (!existsSync(MEDIA_DIR + name)) writeFileSync(MEDIA_DIR + name, bytes);
  return { generationId, sourceUrl, videoUrl: `${publicUrl()}/media/${name}` };
}

/** Single-line, escape-free result text (so escaped and raw MIP-004 hashes coincide). */
export function resultText(videoUrl: string, generationId: string, input: VideoInput) {
  const safe = (s: string) => s.replace(/[\u0000-\u001f"\\]/g, " ").slice(0, 160);
  const studio = optional("STUDIO_EDIT_URL");
  const edit = studio ? ` | Edit in ReelForge Studio (Omniclip): ${studio.replace("{video}", encodeURIComponent(videoUrl)).replace("{gen}", encodeURIComponent(generationId))}` : "";
  return `![ReelForge reel](${videoUrl}) ReelForge video ready (${input.aspect_ratio ?? "9:16"}): ${videoUrl}${edit} | generation ${safe(generationId)} | prompt: ${safe(input.prompt).replace(/[\[\]()]/g, " ")}`;
}