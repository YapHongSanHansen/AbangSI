/**
 * Durable job journal (JSON file, atomic rename). Jobs, signed terms, lock and
 * result references survive restarts, so a sold job is never forgotten and a
 * result or withdrawal is never submitted twice.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const DATA_DIR = process.env.REELFORGE_DATA_DIR ?? fileURLToPath(new URL("../data/", import.meta.url));
const FILE = `${DATA_DIR}jobs.json`;

export type Channel = "mip003" | "x402" | "sokosumi";
export type JobStatus = "awaiting_payment" | "running" | "completed" | "failed";

export interface VideoInput { prompt: string; aspect_ratio?: "9:16" | "16:9" | "1:1"; duration?: number; resolution?: "480p" | "720p" | "1080p"; style?: string; image_url?: string; reference_video_url?: string; reference_image_urls?: string[]; source_files?: Array<{ name: string; kind: string; chars: number }>; prompt_via?: "openai" | "excerpt" }

export interface Iteration { n: number; at: number; instructions?: string; prompt: string; generationId?: string; videoUrl?: string; result?: string; resultHash?: string; error?: string }

export interface Job {
  id: string;
  channel: Channel;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  input: VideoInput;
  /** identifier_from_purchaser (buyer nonce). */
  nonce: string;
  inputHash: string;
  /** Escrow expectations (bigints stored as decimal strings). */
  expected?: Record<string, string>;
  blockchainIdentifier?: string;
  agentIdentifier?: string;
  sellerVKey?: string;
  terms?: Record<string, unknown>;
  lockTx?: string;
  lockIndex?: number;
  generationId?: string;
  videoUrl?: string;
  result?: string;
  resultHash?: string;
  resultTx?: string;
  /** True once the SubmitResult carrying resultHash is confirmed on chain. */
  resultConfirmed?: boolean;
  collectTx?: string;
  sokosumiTaskId?: string;
  /** Quoted price for this hire (human-readable) and its breakdown. */
  price?: { tusdm: string; ada: string; summary: string };
  /** Generations delivered under this hire (1 = first delivery; max MAX_ITERATIONS_PER_HIRE). */
  iterations?: Iteration[];
  /** Last Sokosumi event already handled (revision requests are newer user comments). */
  sokosumiSeenAt?: string;
  error?: string;
  log: string[];
}

let jobs = new Map<string, Job>();
if (existsSync(FILE)) jobs = new Map((JSON.parse(readFileSync(FILE, "utf8")) as Job[]).map(j => [j.id, j]));

function flush() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...jobs.values()], null, 2));
  renameSync(tmp, FILE);
}

export const store = {
  all: () => [...jobs.values()],
  get: (id: string) => jobs.get(id),
  find: (pred: (j: Job) => boolean) => [...jobs.values()].find(pred),
  create(partial: Omit<Job, "id" | "createdAt" | "updatedAt" | "log" | "status"> & { status?: JobStatus }): Job {
    const now = Date.now();
    const job: Job = { id: randomUUID(), status: "awaiting_payment", createdAt: now, updatedAt: now, log: [], ...partial };
    jobs.set(job.id, job);
    flush();
    return job;
  },
  update(id: string, patch: Partial<Job>, note?: string): Job {
    const job = jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    Object.assign(job, patch, { updatedAt: Date.now() });
    if (note) { job.log.push(`${new Date().toISOString()} ${note}`); console.log(`[job ${id.slice(0, 8)}] ${note}`); }
    flush();
    return job;
  },
};

export const big = (o: Record<string, bigint | string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));