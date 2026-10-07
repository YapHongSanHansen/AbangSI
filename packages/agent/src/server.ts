/**
 * ReelForge agent server (Cardano preprod).
 *
 *   GET  /availability            MIP-003 health (the Masumi registry marks the agent Online from it)
 *   GET  /input_schema            MIP-003 input form
 *   POST /start_job               MIP-003 standard path: seller-signed escrow terms (Sokosumi / any Masumi buyer)
 *   GET  /status?job_id=          MIP-003 status (+ result once completed)
 *   POST /provide_input           MIP-003 (not used: ReelForge never asks for more input)
 *   POST /x402/generate           x402 'exact' + Masumi escrow, priced in tADA
 *   POST /x402/generate/tusdm     x402 'exact' + Masumi escrow, priced in Masumi tUSDM
 *   GET  /jobs/:id                job + on-chain references (no secrets)
 *   GET  /media/:file             durable copies of generated videos (CORS + Range)
 *
 * Settlement: a watcher finds each job's escrow lock, checks it against the
 * terms ReelForge signed, generates the video, then submits the result hash on
 * chain (vested_pay SubmitResult). A collector withdraws every finished escrow
 * after its unlock time (vested_pay Withdraw). No Masumi Payment Service needed.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { decodeCardanoTransaction, toFacilitatorCardanoSigner, type CardanoExtraMasumi } from "@x402/cardano";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { ExactCardanoScheme as ServerScheme } from "@x402/cardano/exact/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPTransportContext } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { agentIdentifier, blockfrost, optional, port, priceLovelace, priceTusdmUnits, publicUrl, sellerWallet } from "./config.js";
import { createChain, lockMismatch, type EscrowLock, type ExpectedLock } from "./chain.js";
import { ESCROW_ADDRESS, explorerTx, NETWORK, paymentKeyHash, TUSDM_UNIT, TUSDM_X402_ASSET } from "./constants.js";
import { inputHash, issueTerms, NONCE_RE, resultHash, STATE } from "./masumi.js";
import { big, store, type Job } from "./store.js";
import { generateVideo, INPUT_SCHEMA, MEDIA_DIR, parseVideoInput, resultText } from "./video.js";
import { startCoworkerRuntime } from "./sokosumi.js";
import { quote, quoteSummary } from "./pricing.js";
import { iterations, MAX_ITERATIONS, revise, revisionsLeft } from "./revisions.js";

const seller = sellerWallet();
const agentId = agentIdentifier();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address, log: m => console.log(`[chain] ${m}`) });

// ---------------------------------------------------------------- x402

const facilitatorClient: FacilitatorClient = optional("FACILITATOR_URL") && optional("LOCAL_FACILITATOR") !== "1"
  ? new HTTPFacilitatorClient({ url: optional("FACILITATOR_URL") })
  : (() => {
      const f = new x402Facilitator().register(NETWORK, new FacilitatorScheme(
        toFacilitatorCardanoSigner({ network: NETWORK, provider: { blockfrost }, awaitConfirmation: false })));
      return {
        verify: (p, r) => f.verify(p, r),
        settle: (p, r) => f.settle(p, r),
        getSupported: async () => f.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
      } satisfies FacilitatorClient;
    })();

/** x402 escrow deadlines: video generation needs more than the 15-minute default. */
const X402_DEADLINES = { submitResultAfterPayByMs: 30 * 60_000, unlockAfterPayByMs: 50 * 60_000, externalDisputeUnlockAfterPayByMs: 70 * 60_000 };

/** Per-request x402 price from the request body (length, resolution, prompt complexity). */
const dynamicPrice = (asset: "lovelace" | "tusdm") => async (ctx: { adapter: { getBody?: () => unknown } }) => {
  const body = ctx.adapter.getBody?.() as Record<string, unknown> | undefined;
  const input = parseVideoInput(body?.input_data ?? body);
  const q = quote(typeof input === "string" ? { prompt: "invalid" } : input);
  return asset === "lovelace" ? { amount: q.lovelace.toString(), asset: "lovelace" } : { amount: q.tusdmUnits.toString(), asset: TUSDM_X402_ASSET };
};

function x402Offer(path: string, price: ReturnType<typeof dynamicPrice>, label: string) {
  const server = new x402ResourceServer(facilitatorClient).register(NETWORK, new ServerScheme({
    masumi: {
      seller: seller.signer,
      deadlines: X402_DEADLINES,
      // Bind the escrow's input_hash to the exact job request (validated before the gate).
      commitment: ({ transportContext }) => {
        const body = (transportContext as HTTPTransportContext).request.adapter.getBody?.() as Record<string, unknown>;
        const input = parseVideoInput(body?.input_data ?? body);
        return [{ name: "body", canonicalization: "jcs", mediaType: "application/json", content: { input_data: input } }];
      },
    },
  }));
  server.onVerifyFailure(async ({ error }) => { console.warn(`[x402 verify ${path}] ${error.message}`); });
  server.onSettleFailure(async ({ error }) => { console.warn(`[x402 settle ${path}] ${error.message}`); });
  const http = new x402HTTPResourceServer(server, {
    [`POST ${path}`]: {
      resource: `${publicUrl()}${path}`,
      accepts: {
        scheme: "exact", network: NETWORK, payTo: ESCROW_ADDRESS, maxTimeoutSeconds: 300, price,
        extra: { assetTransferMethod: "masumi", areFeesSponsored: false },
      },
      description: "ReelForge: one AI-generated video reel, paid into Masumi escrow", mimeType: "application/json",
    },
  });
  return { path, price: label, server, http };
}

const offers = [
  ...(priceLovelace ? [x402Offer("/x402/generate", dynamicPrice("lovelace"), "tADA, per request")] : []),
  x402Offer("/x402/generate/tusdm", dynamicPrice("tusdm"), "tUSDM, per request"),
];

/** Records a verified x402 payment as a job (runs before settlement, and again on retries: idempotent). */
function x402Job(req: Request): Job {
  const payment = decodePaymentSignatureHeader((req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"))!);
  const { txHash } = decodeCardanoTransaction(String(payment.payload.transaction));
  const existing = store.find(j => j.lockTx === txHash);
  if (existing) return existing;
  const extra = payment.accepted.extra as unknown as CardanoExtraMasumi;
  const { terms } = extra;
  const parsed = parseVideoInput((extra.inputCommitment.parts[0].content as { input_data: unknown }).input_data);
  if (typeof parsed === "string") throw new Error(parsed);
  const q = quote(parsed);
  const input = { ...parsed, duration: q.durationSeconds, resolution: q.resolution };
  return store.create({
    channel: "x402", input, nonce: terms.buyerNonce, inputHash: terms.inputHash, lockTx: txHash,
    price: { tusdm: q.tusdm, ada: (Number(payment.accepted.amount) / 1e6).toFixed(2), summary: payment.accepted.asset === "lovelace" ? `${(Number(payment.accepted.amount) / 1e6).toFixed(2)} tADA — ${quoteSummary(q)}` : quoteSummary(q) },
    blockchainIdentifier: extra.blockchainIdentifier, sellerVKey: paymentKeyHash(terms.sellerAddress),
    expected: big({
      sellerAddress: terms.sellerAddress, referenceKey: extra.referenceKey, referenceSignature: extra.referenceSignature,
      sellerNonce: terms.sellerNonce, buyerNonce: terms.buyerNonce, agentIdentifier: terms.agentIdentifier ?? "",
      inputHash: terms.inputHash, payByTime: terms.payByTime, submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime, externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      unit: payment.accepted.asset, amount: payment.accepted.amount,
    }),
  });
}

// ---------------------------------------------------------------- settlement watcher
//
// Each paid job runs independently (bounded by the tx queue in chain.ts):
//   awaiting_payment → lock found & matches signed terms → running (generate once, reuse on retry)
//   → SubmitResult → confirmed on chain → completed (only now is the result revealed).
// A job is re-resolved by escrow identity before submitting, so a buyer's SetRefundRequested
// cannot strand it: SubmitResult from RefundRequested moves the escrow to Disputed.

/** Stop generating this long before submit_result_time (leaves room for SubmitResult + confirmation). */
const SUBMIT_MARGIN_MS = 10 * 60_000;
const ignored = new Set<string>();
const inFlight = new Set<string>();

function expectedOf(job: Job): ExpectedLock {
  const e = job.expected!;
  return {
    sellerAddress: e.sellerAddress, referenceKey: e.referenceKey, referenceSignature: e.referenceSignature,
    sellerNonce: e.sellerNonce, buyerNonce: e.buyerNonce, agentIdentifier: e.agentIdentifier, inputHash: e.inputHash,
    payByTime: BigInt(e.payByTime), submitResultTime: BigInt(e.submitResultTime), unlockTime: BigInt(e.unlockTime),
    externalDisputeUnlockTime: BigInt(e.externalDisputeUnlockTime), unit: e.unit, amount: BigInt(e.amount),
  };
}

async function findLock(job: Job, tusdmLocks: () => Promise<EscrowLock[]>): Promise<EscrowLock | null> {
  const expected = expectedOf(job);
  const candidates = job.channel === "x402" ? await chain.locksOfTx(job.lockTx!) : (await tusdmLocks()).filter(l => l.datum?.sellerNonce === expected.sellerNonce);
  for (const c of candidates) {
    const why = lockMismatch(c, expected);
    if (!why) return c;
    const key = `${job.id}:${c.txHash}#${c.outputIndex}`;
    if (!ignored.has(key)) { ignored.add(key); console.warn(`[job ${job.id.slice(0, 8)}] ignoring escrow ${c.txHash}#${c.outputIndex}: ${why}`); }
  }
  return null;
}

/** The job's escrow as it is now: original out-ref if unspent, else found by identity. Must be unresolved by us yet. */
async function currentLock(job: Job): Promise<EscrowLock | null> {
  const e = expectedOf(job);
  const original = job.lockTx !== undefined && job.lockIndex !== undefined ? await chain.lockByRef(job.lockTx, job.lockIndex) : null;
  const lock = original ?? await chain.resolveByIdentity(e.sellerNonce, e.referenceSignature, e.unit);
  if (!lock?.datum) return null;
  // Immutable terms must still match what we signed (state may legitimately be RefundRequested).
  const asFresh = { ...lock, datum: { ...lock.datum, state: STATE.FundsLocked, buyerCooldownTime: 0n } };
  const why = lockMismatch(asFresh, e);
  if (why) throw new Error(`escrow no longer matches terms: ${why}`);
  return lock;
}

async function confirmSubmitted(job: Job): Promise<boolean> {
  const [cont] = await chain.locksOfTx(job.resultTx!);
  if (cont?.datum && cont.datum.resultHash === job.resultHash) return true;
  // Spent already (e.g. collected) also proves it landed.
  const r = await fetch(`${blockfrost.baseUrl}/txs/${job.resultTx}`, { headers: { project_id: blockfrost.projectId } });
  return r.ok;
}

async function advance(job: Job, tusdmLocks: () => Promise<EscrowLock[]>) {
  const e = job.expected!;
  // Resume: a SubmitResult that was sent but not yet seen confirmed.
  if (job.status === "running" && job.resultTx) {
    if (await confirmSubmitted(job)) { store.update(job.id, { status: "completed", resultConfirmed: true }, `SubmitResult confirmed ${job.resultTx}`); return; }
    if (Date.now() < job.updatedAt + 10 * 60_000) return; // still propagating
    store.update(job.id, { resultTx: undefined }, "SubmitResult never landed — will resubmit");
  }
  if (Date.now() > Number(e.submitResultTime) - 3 * 60_000) {
    store.update(job.id, { status: "failed", error: job.error ?? "Result deadline passed without a confirmed result (buyer can reclaim via WithdrawRefund)." }, "deadline passed");
    return;
  }
  let lock: EscrowLock | null;
  if (job.status === "awaiting_payment") {
    lock = await findLock(job, tusdmLocks);
    if (!lock) {
      // Unpaid quotes expire shortly after their pay-by time.
      if (Date.now() > Number(e.payByTime) + 10 * 60_000) store.update(job.id, { status: "failed", error: "No escrow payment arrived before the pay-by time." }, "quote expired unpaid");
      return;
    }
    store.update(job.id, { status: "running", lockTx: lock.txHash, lockIndex: lock.outputIndex }, `escrow FundsLocked ${lock.txHash}#${lock.outputIndex}`);
  }
  // Generate once; a retry after a later failure reuses the stored video.
  if (!job.videoUrl || !job.resultHash) {
    const before = await currentLock(job);
    if (!before) throw new Error("escrow not found");
    if (before.datum!.state !== STATE.FundsLocked) {
      store.update(job.id, { status: "failed", error: `Escrow state ${before.datum!.state} before work started (refund requested) — not generating.` }, "refund requested before work; skipped");
      return;
    }
    store.update(job.id, {}, "generating video");
    const video = await generateVideo(job.input, Number(e.submitResultTime) - SUBMIT_MARGIN_MS);
    const result = resultText(video.videoUrl, video.generationId, job.input);
    store.update(job.id, { generationId: video.generationId, videoUrl: video.videoUrl, result, resultHash: resultHash(job.nonce, result) }, "video ready (withheld until the result hash is confirmed on chain)");
  }
  const fresh = store.get(job.id)!;
  const lockNow = await currentLock(fresh);
  if (!lockNow) throw new Error("escrow not found before SubmitResult");
  await chain.submitResult(lockNow, fresh.resultHash!, h => store.update(job.id, { resultTx: h }, `SubmitResult submitted ${explorerTx(h)}`));
  store.update(job.id, { status: "completed", resultConfirmed: true }, `SubmitResult confirmed ${store.get(job.id)!.resultTx}`);
}

let scanning = false;
async function watch() {
  if (scanning) return;
  scanning = true;
  try {
    const due = store.all().filter(j => (j.status === "awaiting_payment" || j.status === "running") && j.expected && !inFlight.has(j.id));
    let cache: Promise<EscrowLock[]> | undefined;
    const tusdmLocks = () => (cache ??= chain.locksWithUnit(TUSDM_UNIT));
    for (const job of due) {
      inFlight.add(job.id);
      void advance(job, tusdmLocks)
        .catch(error => {
          const msg = error instanceof Error ? error.message : String(error);
          const j = store.get(job.id)!;
          // Keep 'running' (the video is reused); never regress a confirmed job.
          if (j.status !== "completed") store.update(job.id, { error: msg }, `will retry: ${msg}`);
        })
        .finally(() => inFlight.delete(job.id));
    }
  } finally { scanning = false; }
}

/** Withdraws only escrows our own SubmitResult created; pauses while any job is mid-flight (tx queue priority). */
let collecting = false;
async function collect() {
  if (collecting || store.all().some(j => j.status === "running" && j.resultHash && !j.resultConfirmed)) return; // only yield while a SubmitResult is in the tx queue
  collecting = true;
  try {
    for (const job of store.all().filter(j => j.resultConfirmed && j.resultTx && j.resultTx !== "unpaid" && !j.collectTx)) {
      try {
        const { lock, reason } = await chain.collectible(job.resultTx!);
        if (!lock) { if (reason.startsWith("no unspent")) store.update(job.id, { collectTx: "unknown-spent" }, `escrow output spent: ${reason}`); continue; }
        const e = expectedOf(job);
        const key = e.unit.toLowerCase().replace(".", "");
        const value = key === "lovelace" ? lock.lovelace - lock.datum!.collateralReturnLovelace : lock.tokens[key] ?? 0n;
        if (value < e.amount) { console.warn(`[collect] ${job.id.slice(0, 8)} escrow holds ${value} < price ${e.amount}; skipped`); continue; }
        const tx = await chain.withdraw(lock);
        store.update(job.id, { collectTx: tx }, `seller collected ${explorerTx(tx)}`);
      } catch (error) { console.warn(`[collect] ${job.id.slice(0, 8)}: ${error instanceof Error ? error.message : error}`); }
    }
  } finally { collecting = false; }
}

/** Per-IP fixed-window limiter for unauthenticated, quote-issuing routes. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT")) return next();
    const ip = req.ip ?? "?";
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + windowMs });
    else if (++h.n > max) { res.status(429).json({ error: "Too many quote requests; slow down." }); return; }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}
const quoteLimit = rateLimit(20, 60_000);

// ---------------------------------------------------------------- HTTP

const app = express();
app.set("trust proxy", "loopback");
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"], allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/media", express.static(MEDIA_DIR, { immutable: true, maxAge: "365d", setHeaders: r => r.setHeader("Cross-Origin-Resource-Policy", "cross-origin") }));

const view = (j: Job) => ({
  job_id: j.id, id: j.id, channel: j.channel, status: j.status, input: j.input,
  price: j.price,
  ...(j.status === "completed" && j.resultConfirmed ? { video_url: j.videoUrl, result: j.result, iterations: iterations(j).map(i => ({ n: i.n, video_url: i.videoUrl, instructions: i.instructions, result_hash: i.resultHash })), revisions_left: revisionsLeft(j), max_iterations: MAX_ITERATIONS } : {}),
  identifierFromPurchaser: j.nonce, input_hash: j.inputHash, result_hash: j.resultHash, blockchainIdentifier: j.blockchainIdentifier,
  escrow: ESCROW_ADDRESS, lock_tx: j.lockTx, result_tx: j.resultTx, collect_tx: j.collectTx, error: j.error, log: j.log,
  deadlines: j.expected && { payByTime: j.expected.payByTime, submitResultTime: j.expected.submitResultTime, unlockTime: j.expected.unlockTime, externalDisputeUnlockTime: j.expected.externalDisputeUnlockTime },
});

app.get("/", (_req, res) => {
  res.json({
    name: "ReelForge", description: "Prompt → AI video reel (Higgsfield). Masumi MIP-003 agent on Cardano preprod with x402 escrow payments.",
    network: NETWORK, agentIdentifier: agentId ?? null, seller: seller.address, escrow: ESCROW_ADDRESS,
    endpoints: ["/availability", "/input_schema", "/start_job", "/status?job_id=", "/quote", "/jobs/:id/revisions", ...offers.map(o => o.path)],
    pricing: "per request: base + per-second length + prompt complexity, × resolution (POST /quote)", max_iterations_per_hire: MAX_ITERATIONS,
    x402: offers.map(o => ({ path: o.path, price: o.price })),
  });
});
app.get("/availability", (_req, res) => {
  res.json({ status: "available", type: "masumi-agent", agentIdentifier: agentId ?? null, message: "ReelForge turns a prompt into a short AI video reel." });
});
app.get("/input_schema", (_req, res) => { res.json(INPUT_SCHEMA); });

/** MIP-003 start_job (standard Masumi path, priced Dynamic in tUSDM). */
app.post("/start_job", quoteLimit, async (req, res, next) => {
  try {
    if (!agentId) { res.status(503).json({ error: "Agent not registered yet (MASUMI_AGENT_IDENTIFIER unset)." }); return; }
    const nonce = String(req.body?.identifier_from_purchaser ?? "").toLowerCase();
    if (!NONCE_RE.test(nonce)) { res.status(400).json({ error: "identifier_from_purchaser must be 14–26 lowercase hex characters (even length)" }); return; }
    const parsed = parseVideoInput(req.body?.input_data);
    if (typeof parsed === "string") { res.status(400).json({ error: parsed }); return; }
    const q = quote(parsed);
    const input = { ...parsed, duration: q.durationSeconds, resolution: q.resolution };
    if (store.all().filter(j => j.status === "awaiting_payment").length > 200) { res.status(503).json({ error: "Too many open jobs" }); return; }
    // The hash commits to input_data exactly as the buyer sent it (Sokosumi recomputes it).
    const hash = inputHash(nonce, req.body.input_data);
    const terms = await issueTerms({
      identifierFromPurchaser: nonce, inputHash: hash, agentIdentifier: agentId, sellerAddress: seller.address,
      funds: [{ amount: q.tusdmUnits.toString(), unit: TUSDM_UNIT }], sign: seller.signTerms,
    });
    const job = store.create({
      channel: "mip003", input, price: { tusdm: q.tusdm, ada: q.ada, summary: quoteSummary(q) }, nonce, inputHash: hash, blockchainIdentifier: terms.blockchainIdentifier, agentIdentifier: agentId, sellerVKey: terms.sellerVKey,
      expected: big({
        sellerAddress: seller.address, referenceKey: terms.referenceKey, referenceSignature: terms.referenceSignature,
        sellerNonce: terms.sellerNonce, buyerNonce: nonce, agentIdentifier: agentId, inputHash: hash,
        payByTime: String(terms.payByTime), submitResultTime: String(terms.submitResultTime), unlockTime: String(terms.unlockTime),
        externalDisputeUnlockTime: String(terms.externalDisputeUnlockTime), unit: TUSDM_UNIT, amount: q.tusdmUnits.toString(),
      }),
    });
    res.json({
      price: { tusdm: q.tusdm, breakdown: q.breakdown, max_iterations: MAX_ITERATIONS },
      id: job.id, job_id: job.id, status: "awaiting_payment",
      blockchainIdentifier: terms.blockchainIdentifier, payByTime: terms.payByTime, submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime, externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      agentIdentifier: agentId, sellerVKey: terms.sellerVKey, identifierFromPurchaser: nonce, input_hash: hash,
      paymentSourceType: terms.paymentSourceType, supportedPaymentSourceIndex: terms.supportedPaymentSourceIndex,
      amounts: terms.RequestedFunds,
    });
  } catch (error) { next(error); }
});

app.get("/status", (req, res) => {
  const job = store.get(String(req.query.job_id ?? ""));
  if (!job) { res.status(404).json({ error: "Unknown job_id" }); return; }
  res.json({ job_id: job.id, status: job.status, ...(job.status === "completed" && job.resultConfirmed && job.result ? { result: job.result } : {}), ...(job.error && job.status === "failed" ? { message: job.error } : {}) });
});
/** Free quote: what a request would cost (no signature, no job). */
app.post("/quote", quoteLimit, (req, res) => {
  const input = parseVideoInput(req.body?.input_data ?? req.body);
  if (typeof input === "string") { res.status(400).json({ error: input }); return; }
  const q = quote(input);
  res.json({ tusdm: q.tusdm, ada: q.ada, duration_seconds: q.durationSeconds, resolution: q.resolution, complexity: q.complexity, breakdown: q.breakdown, max_iterations_per_hire: MAX_ITERATIONS });
});

/** Revision on a delivered hire. The job id (returned only to the buyer) is the access key. */
app.post("/jobs/:id/revisions", quoteLimit, async (req, res) => {
  const job = store.get(req.params.id);
  if (!job) { res.status(404).json({ error: "Unknown job" }); return; }
  const out = await revise(job.id, String(req.body?.instructions ?? ""));
  if (out.ok) res.json({ revision: out.iteration.n, of: MAX_ITERATIONS, revisions_left: out.left, video_url: out.iteration.videoUrl, result: out.iteration.result, result_hash: out.iteration.resultHash });
  else res.status(out.reason === "limit_reached" ? 402 : out.reason === "busy" ? 409 : out.reason === "not_delivered" ? 425 : 500).json({ error: out.message, reason: out.reason, ...(out.reason === "limit_reached" ? { rehire: "Start a new paid job (POST /start_job or an x402 route) to continue." } : {}) });
});

app.post("/provide_input", (_req, res) => { res.status(400).json({ error: "ReelForge never requests additional input" }); });
app.get("/jobs/:id", (req, res) => { const j = store.get(req.params.id); if (j) res.json(view(j)); else res.status(404).json({ error: "Unknown job" }); });
app.get("/jobs", (req, res) => {
  const admin = optional("ADMIN_TOKEN");
  if (!admin || req.get("authorization") !== `Bearer ${admin}`) { res.status(401).json({ error: "admin token required" }); return; }
  res.json(store.all().slice(-50).reverse().map(view));
});

for (const offer of offers) {
  const gate = paymentMiddlewareFromHTTPServer(offer.http, undefined, undefined, false);
  app.post(offer.path, quoteLimit, (req, res, next) => {
    const input = parseVideoInput(req.body?.input_data ?? req.body);
    if (typeof input === "string") res.status(400).json({ error: input }); else next();
  }, gate, (req, res, next) => { try { res.json(view(x402Job(req))); } catch (e) { next(e); } });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[agent]", error instanceof Error ? error.message : error);
  res.status(500).json({ error: "ReelForge could not process this request." });
});

for (const job of store.all()) {
  if (job.status === "completed" && job.resultTx && job.resultConfirmed === undefined && job.log.some(l => l.includes("SubmitResult confirmed"))) store.update(job.id, { resultConfirmed: true });
  // Jobs funded before chat narration existed: never post a stale "escrow funded / generating" message.
  if (job.channel === "sokosumi" && job.lockTx && job.status !== "awaiting_payment" && !job.log.some(l => l.includes("chat:locked"))) store.update(job.id, {}, "chat:locked skipped (pre-narration job)");
  // Delivered before revisions existed: accept revision requests from now on.
  if (job.channel === "sokosumi" && !job.sokosumiSeenAt && job.log.some(l => l.includes("reported to Sokosumi"))) store.update(job.id, { sokosumiSeenAt: new Date().toISOString() });
}
for (const offer of offers) { await offer.server.initialize(); await offer.http.initialize(); }
setInterval(() => { void watch(); }, 10_000);
setInterval(() => { void collect(); }, 30_000);
app.listen(port, () => {
  console.log(`ReelForge on http://localhost:${port}  public ${publicUrl()}`);
  console.log(`  seller  ${seller.address}\n  agent   ${agentId ?? "(not registered)"}\n  escrow  ${ESCROW_ADDRESS}`);
  console.log(`  x402    ${offers.map(o => `${o.path} (${o.price})`).join(", ")}  · max ${MAX_ITERATIONS} generations per hire`);
  void watch(); void collect();
  if (agentId) startCoworkerRuntime({ agentIdentifier: agentId, sellerAddress: seller.address, sign: seller.signTerms });
});
export { app, chain, STATE };