/**
 * Per-request pricing: every quote depends on the requested video length,
 * resolution and how complex the prompt is. The same quote is used by every
 * channel (Sokosumi coworker Tasks, MIP-003 /start_job, x402) and is signed
 * into the escrow terms, so the buyer pays exactly the quoted amount.
 *
 *   price_tUSDM = (BASE + PER_SECOND × seconds + complexity surcharge) × resolution factor
 *   price_tADA  = price_tUSDM × ADA_PER_TUSDM   (x402 tADA route, min 2 tADA for min-UTxO)
 *
 * Defaults keep a simple 5 s 720p reel at exactly 1 tUSDM / 5 tADA. All rates are env-tunable.
 */
import { optional } from "./config.js";
import { extractAttachments } from "./attachments.js";

export type Resolution = "480p" | "720p" | "1080p";
export type Tier = "simple" | "standard" | "complex";

/** text = text-to-video, image = image-to-video, swap = video + reference photos (Genjutsu motion-transfer). */
export type Mode = "text" | "image" | "swap";
export interface PricingInput { prompt: string; duration?: number; resolution?: Resolution; mode?: Mode; documents?: number }

export interface Quote {
  mode: Mode;
  durationSeconds: number;
  resolution: Resolution;
  complexity: { tier: Tier; score: number; words: number; scenes: number; features: string[] };
  /** Masumi tUSDM base units (6 decimals). */
  tusdmUnits: bigint;
  lovelace: bigint;
  tusdm: string;
  ada: string;
  breakdown: string[];
}

const num = (name: string, fallback: number) => {
  const v = Number(optional(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};
export const rates = () => ({
  base: num("PRICE_BASE_TUSDM", 0.4),
  perSecond: num("PRICE_PER_SECOND_TUSDM", 0.12),
  standard: num("PRICE_STANDARD_SURCHARGE_TUSDM", 0.25),
  complex: num("PRICE_COMPLEX_SURCHARGE_TUSDM", 0.6),
  perExtraScene: num("PRICE_PER_EXTRA_SCENE_TUSDM", 0.15),
  swapPerSecond: num("PRICE_SWAP_PER_SECOND_TUSDM", 0.4),
  perDocument: num("PRICE_PER_DOCUMENT_TUSDM", 0.2),
  res: { "480p": num("PRICE_480P_FACTOR", 0.8), "720p": 1, "1080p": num("PRICE_1080P_FACTOR", 1.6) } as Record<Resolution, number>,
  adaPerTusdm: num("PRICE_ADA_PER_TUSDM", 5),
  minDuration: 4,
  maxDuration: num("MAX_DURATION_SECONDS", 15),
  maxSwapDuration: num("MAX_SWAP_SECONDS", 30),
});

const FEATURES: Array<[string, RegExp]> = [
  ["camera move", /\b(drone|aerial|pan(ning)?|orbit(ing)?|dolly|tracking shot|zoom|push[- ]?in|pull[- ]?out|crane|fpv|handheld|rack focus)\b/i],
  ["people / characters", /\b(person|people|man|woman|child|crowd|dancer|character|actor|face|portrait)\b/i],
  ["text / logo", /\b(logo|text|title|caption|typography|words?|lettering)\b/i],
  ["effects", /\b(explosion|fire|smoke|rain|snow|particles?|neon|glitch|hologram|lightning|fireworks)\b/i],
  ["slow motion / time", /\b(slow[- ]?mo(tion)?|time[- ]?lapse|hyperlapse|freeze frame)\b/i],
];
const SCENE_BREAKS = /\b(then cut to|then|cut to|next scene|after that|followed by|transition(s|ing)? to|scene \d)\b|;/gi;

/** Reads the requested length/resolution from explicit fields first, else from the prompt text. */
export function requestedSpecs(input: PricingInput) {
  const r = rates();
  const fromText = input.prompt.match(/\b(\d{1,2})\s*(s|sec|secs|seconds?)\b/i);
  const raw = input.duration ?? (fromText ? Number(fromText[1]) : 5);
  const cap = input.mode === "swap" ? r.maxSwapDuration : r.maxDuration;
  const durationSeconds = Math.min(cap, Math.max(r.minDuration, Math.round(raw)));
  const resolution: Resolution = input.resolution ?? (/\b(1080p|full ?hd|fhd)\b/i.test(input.prompt) ? "1080p" : /\b480p\b/i.test(input.prompt) ? "480p" : "720p");
  return { durationSeconds, resolution };
}

export function complexity(raw: string) {
  const prompt = extractAttachments(raw).text;
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  const scenes = 1 + (prompt.match(SCENE_BREAKS)?.length ?? 0);
  const features = FEATURES.filter(([, re]) => re.test(prompt)).map(([name]) => name);
  const score = Math.round((words / 15 + (scenes - 1) * 1.5 + features.length * 0.5) * 10) / 10;
  const tier: Tier = score < 2 ? "simple" : score < 4 ? "standard" : "complex";
  return { tier, score, words, scenes, features };
}

const ceil5 = (x: number) => Math.ceil(x * 20 - 1e-9) / 20; // round up to 0.05

export function quote(input: PricingInput): Quote {
  const r = rates();
  const { durationSeconds, resolution } = requestedSpecs(input);
  const c = complexity(input.prompt);
  const surcharge = c.tier === "complex" ? r.complex : c.tier === "standard" ? r.standard : 0;
  const scenes = Math.max(0, c.scenes - 1) * r.perExtraScene;
  const mode: Mode = input.mode ?? "text";
  const perSecond = mode === "swap" ? r.swapPerSecond : r.perSecond;
  const docs = Math.min(5, input.documents ?? 0) * r.perDocument;
  const subtotal = r.base + perSecond * durationSeconds + surcharge + scenes + docs;
  const tusdm = ceil5(subtotal * r.res[resolution]);
  const ada = Math.max(2, ceil5(tusdm * r.adaPerTusdm));
  return {
    mode, durationSeconds, resolution, complexity: c,
    tusdmUnits: BigInt(Math.round(tusdm * 1e6)), lovelace: BigInt(Math.round(ada * 1e6)),
    tusdm: tusdm.toFixed(2), ada: ada.toFixed(2),
    breakdown: [
      `base ${r.base.toFixed(2)}`,
      `${mode === "swap" ? "character swap, " : mode === "image" ? "image-to-video, " : ""}${durationSeconds}s × ${perSecond.toFixed(2)} = ${(perSecond * durationSeconds).toFixed(2)}`,
      `${c.tier} prompt (score ${c.score}: ${c.words} words, ${c.scenes} scene${c.scenes > 1 ? "s" : ""}${c.features.length ? `, ${c.features.join(", ")}` : ""}) +${surcharge.toFixed(2)}`,
      ...(scenes ? [`extra scenes +${scenes.toFixed(2)}`] : []),
      ...(docs ? [`${input.documents} file${input.documents === 1 ? "" : "s"} read +${docs.toFixed(2)}`] : []),
      `${resolution} × ${r.res[resolution]}`,
      `= ${tusdm.toFixed(2)} tUSDM (x402: ${ada.toFixed(2)} tADA)`,
    ],
  };
}

/** One-line human summary used in Task comments and job views. */
export const quoteSummary = (q: Quote) =>
  `${q.tusdm} tUSDM for a ${q.durationSeconds}s ${q.resolution} ${q.mode === "swap" ? "character swap" : q.mode === "image" ? "image-to-video reel" : "reel"}, ${q.complexity.tier} prompt (${q.breakdown.slice(0, -1).join("; ")})`;