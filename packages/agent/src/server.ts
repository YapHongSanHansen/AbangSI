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

function x402Offer(path: string, price: { amount: string; asset: string }) {
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
  return { path, price, server, http };
}

const offers = [
  ...(priceLovelace ? [x402Offer("/x402/generate", { amount: priceLovelace.toString(), asset: "lovelace" })] : []),
  x402Offer("/x402/generate/tusdm", { amount: priceTusdmUnits.toString(), asset: TUSDM_X402_ASSET }),
];

/** Records a verified x402 payment as a job (runs before settlement, and again on retries: idempotent). */
function x402Job(req: Request): Job {
  const payment = decodePaymentSignatureHeader(req.get("PAYMENT-SIGNATURE")!);
  const { txHash } = decodeCardanoTransaction(String(payment.payload.transaction));
  const existing = store.find(j => j.lockTx === txHash);
  if (existing) return existing;
  const extra = payment.accepted.extra as unknown as CardanoExtraMasumi;
  const { terms } = extra;
  const input = parseVideoInput((extra.inputCommitment.parts[0].content as { input_data: unknown }).input_data);
  if (typeof input === "string") throw new Error(input);
  return store.create({
    channel: "x402", input, nonce: terms.buyerNonce, inputHash: terms.inputHash, lockTx: txHash,
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

const SUBMIT_MARGIN_MS = 4 * 60_000;
const ignored = new Set<string>();

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

async function advance(job: Job, tusdmLocks: () => Promise<EscrowLock[]>) {
  const e = job.expected!;
  if (Date.now() > Number(e.submitResultTime) - SUBMIT_MARGIN_MS) {
    store.update(job.id, { status: "failed", error: job.error ?? "No valid escrow lock arrived before the result deadline (buyer can reclaim via WithdrawRefund)." }, "deadline passed without a lock");
    return;
  }
  const lock = await findLock(job, tusdmLocks);
  if (!lock) {
    if (job.channel === "x402" && Date.now() > Number(e.payByTime) + 5 * 60_000) {
      store.update(job.id, { status: "failed", error: "Payment transaction never landed before its pay-by time." }, "x402 lock never landed");
    }
    return;
  }
  store.update(job.id, { status: "running", lockTx: lock.txHash, lockIndex: lock.outputIndex }, `escrow FundsLocked ${lock.txHash}#${lock.outputIndex} — generating video`);
  const video = await generateVideo(job.input, Number(e.submitResultTime) - SUBMIT_MARGIN_MS);
  const result = resultText(video.videoUrl, video.generationId, job.input);
  const hash = resultHash(job.nonce, result);
  store.update(job.id, { generationId: video.generationId, videoUrl: video.videoUrl, result, resultHash: hash }, `video ready ${video.videoUrl}`);
  const tx = await chain.submitResult(lock, hash, h => store.update(job.id, { resultTx: h }, `SubmitResult submitted ${explorerTx(h)}`));
  store.update(job.id, { status: "completed", resultTx: tx }, `SubmitResult confirmed ${tx}`);
}

let watching = false;
async function watch() {
  if (watching) return;
  watching = true;
  try {
    const waiting = store.all().filter(j => j.status === "awaiting_payment" && j.expected);
    let cache: Promise<EscrowLock[]> | undefined;
    const tusdmLocks = () => (cache ??= chain.locksWithUnit(TUSDM_UNIT));
    for (const job of waiting) {
      try { await advance(job, tusdmLocks); }
      catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const j = store.get(job.id)!;
        if (j.resultTx) { console.warn(`[job ${job.id.slice(0, 8)}] SubmitResult pending: ${msg}`); store.update(job.id, { status: "completed" }); continue; }
        store.update(job.id, { status: "awaiting_payment", error: msg }, `retrying: ${msg}`);
      }
    }
  } finally { watching = false; }
}

let collecting = false;
async function collect() {
  if (collecting) return;
  collecting = true;
  try {
    for (const lock of await chain.dueForCollection()) {
      try {
        const tx = await chain.withdraw(lock);
        const job = store.find(j => j.resultTx === lock.txHash || (j.lockTx === lock.txHash && j.lockIndex === lock.outputIndex));
        if (job) store.update(job.id, { collectTx: tx }, `seller collected ${explorerTx(tx)}`);
        else console.log(`[collect] withdrew ${lock.txHash}#${lock.outputIndex} → ${tx}`);
      } catch (error) { console.warn(`[collect] ${lock.txHash}#${lock.outputIndex}: ${error instanceof Error ? error.message : error}`); }
    }
  } catch (error) { console.warn(`[collect] scan failed: ${error instanceof Error ? error.message : error}`); }
  finally { collecting = false; }
}

// ---------------------------------------------------------------- HTTP

const app = express();
app.set("trust proxy", true);
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"], allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/media", express.static(MEDIA_DIR, { immutable: true, maxAge: "365d", setHeaders: r => r.setHeader("Cross-Origin-Resource-Policy", "cross-origin") }));

const view = (j: Job) => ({
  job_id: j.id, id: j.id, channel: j.channel, status: j.status, input: j.input, video_url: j.videoUrl, result: j.result,
  identifierFromPurchaser: j.nonce, input_hash: j.inputHash, result_hash: j.resultHash, blockchainIdentifier: j.blockchainIdentifier,
  escrow: ESCROW_ADDRESS, lock_tx: j.lockTx, result_tx: j.resultTx, collect_tx: j.collectTx, error: j.error, log: j.log,
  deadlines: j.expected && { payByTime: j.expected.payByTime, submitResultTime: j.expected.submitResultTime, unlockTime: j.expected.unlockTime, externalDisputeUnlockTime: j.expected.externalDisputeUnlockTime },
});

app.get("/", (_req, res) => {
  res.json({
    name: "ReelForge", description: "Prompt → AI video reel (Higgsfield). Masumi MIP-003 agent on Cardano preprod with x402 escrow payments.",
    network: NETWORK, agentIdentifier: agentId ?? null, seller: seller.address, escrow: ESCROW_ADDRESS,
    endpoints: ["/availability", "/input_schema", "/start_job", "/status?job_id=", ...offers.map(o => o.path)],
    x402: offers.map(o => ({ path: o.path, ...o.price })),
  });
});
app.get("/availability", (_req, res) => {
  res.json({ status: "available", type: "masumi-agent", agentIdentifier: agentId ?? null, message: "ReelForge turns a prompt into a short AI video reel." });
});
app.get("/input_schema", (_req, res) => { res.json(INPUT_SCHEMA); });

/** MIP-003 start_job (standard Masumi path, priced Dynamic in tUSDM). */
app.post("/start_job", async (req, res, next) => {
  try {
    if (!agentId) { res.status(503).json({ error: "Agent not registered yet (MASUMI_AGENT_IDENTIFIER unset)." }); return; }
    const nonce = String(req.body?.identifier_from_purchaser ?? "").toLowerCase();
    if (!NONCE_RE.test(nonce)) { res.status(400).json({ error: "identifier_from_purchaser must be 14–26 lowercase hex characters (even length)" }); return; }
    const input = parseVideoInput(req.body?.input_data);
    if (typeof input === "string") { res.status(400).json({ error: input }); return; }
    if (store.all().filter(j => j.status === "awaiting_payment").length > 200) { res.status(503).json({ error: "Too many open jobs" }); return; }
    // The hash commits to input_data exactly as the buyer sent it (Sokosumi recomputes it).
    const hash = inputHash(nonce, req.body.input_data);
    const terms = await issueTerms({
      identifierFromPurchaser: nonce, inputHash: hash, agentIdentifier: agentId, sellerAddress: seller.address,
      funds: [{ amount: priceTusdmUnits.toString(), unit: TUSDM_UNIT }], sign: seller.signTerms,
    });
    const job = store.create({
      channel: "mip003", input, nonce, inputHash: hash, blockchainIdentifier: terms.blockchainIdentifier, agentIdentifier: agentId, sellerVKey: terms.sellerVKey,
      expected: big({
        sellerAddress: seller.address, referenceKey: terms.referenceKey, referenceSignature: terms.referenceSignature,
        sellerNonce: terms.sellerNonce, buyerNonce: nonce, agentIdentifier: agentId, inputHash: hash,
        payByTime: String(terms.payByTime), submitResultTime: String(terms.submitResultTime), unlockTime: String(terms.unlockTime),
        externalDisputeUnlockTime: String(terms.externalDisputeUnlockTime), unit: TUSDM_UNIT, amount: priceTusdmUnits.toString(),
      }),
    });
    res.json({
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
  res.json({ job_id: job.id, status: job.status, ...(job.status === "completed" && job.result ? { result: job.result } : {}), ...(job.error && job.status === "failed" ? { message: job.error } : {}) });
});
app.post("/provide_input", (_req, res) => { res.status(400).json({ error: "ReelForge never requests additional input" }); });
app.get("/jobs/:id", (req, res) => { const j = store.get(req.params.id); if (j) res.json(view(j)); else res.status(404).json({ error: "Unknown job" }); });
app.get("/jobs", (_req, res) => { res.json(store.all().slice(-50).reverse().map(view)); });

for (const offer of offers) {
  const gate = paymentMiddlewareFromHTTPServer(offer.http, undefined, undefined, false);
  app.post(offer.path, (req, res, next) => {
    const input = parseVideoInput(req.body?.input_data ?? req.body);
    if (typeof input === "string") res.status(400).json({ error: input }); else next();
  }, gate, (req, res, next) => { try { res.json(view(x402Job(req))); } catch (e) { next(e); } });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[agent]", error instanceof Error ? error.message : error);
  res.status(500).json({ error: "ReelForge could not process this request." });
});

for (const offer of offers) { await offer.server.initialize(); await offer.http.initialize(); }
setInterval(() => { void watch(); }, 10_000);
setInterval(() => { void collect(); }, 120_000);
app.listen(port, () => {
  console.log(`ReelForge on http://localhost:${port}  public ${publicUrl()}`);
  console.log(`  seller  ${seller.address}\n  agent   ${agentId ?? "(not registered)"}\n  escrow  ${ESCROW_ADDRESS}`);
  console.log(`  x402    ${offers.map(o => `${o.path} (${o.price.amount} ${o.price.asset === "lovelace" ? "lovelace" : "tUSDM units"})`).join(", ")}`);
  void watch(); void collect();
  if (agentId) startCoworkerRuntime({ agentIdentifier: agentId, sellerAddress: seller.address, sign: seller.signTerms, priceUnits: priceTusdmUnits });
});
export { app, chain, STATE };