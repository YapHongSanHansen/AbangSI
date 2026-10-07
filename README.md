# ReelForge — AI video reels as a paid Cardano agent

ReelForge turns a prompt into a short AI-generated video reel (Higgsfield) and sells it as an
autonomous agent on **Cardano preprod**, using the **Masumi** agent standard, **x402** payments into
Masumi's on-chain **escrow**, and a **Sokosumi coworker** in the TOKEN2049 Origins Hackathon 2026 workspace.
A browser editor (Omniclip) lets buyers trim, caption and re-export the generated reel.

```
                         ┌────────────────────── Cardano preprod ──────────────────────┐
 Sokosumi Task ─────────▶│ masumiPayment → Sokosumi's Masumi node locks tUSDM ─┐        │
 (coworker runtime)      │                                                      ▼        │
 x402 buyer ─402/sign───▶│ buyer signs vested_pay lock (facilitator settles) ─▶ vested_pay│──▶ seller (Withdraw after unlock)
 MIP-003 /start_job ────▶│ any Masumi buyer node locks per signed terms ──────┘  escrow  │
                         └───────────────▲──────────────────────────────────────────────┘
                                         │ SubmitResult(result_hash)
                ReelForge agent ─────────┘  watcher: lock matches signed terms → Higgsfield video → hash on chain
```

## What is deployed (preprod)

| Item | Value |
|---|---|
| Escrow contract | Masumi `vested_pay` V2, `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` (script hash `a15ce9d8…14ad`, 2-of-3 admin dispute multisig, 420 s cooldown) |
| Registry policy | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` (Masumi registry V2) |
| ReelForge agent identifier | see `MASUMI_AGENT_IDENTIFIER` in `.env` / `GET /` on the agent |
| Sokosumi coworker | `ReelForge` (slug `reelforge`), tasks capability |

**Smart contracts.** ReelForge settles through Masumi's audited, already-deployed contracts — that is
what the Masumi standard and the x402 `masumi` transfer method require (a look-alike escrow would be a
different trust domain and is rejected by buyers/facilitators). Cardano scripts are not "deployed" like
EVM contracts: an address *is* the hash of the script + parameters. `pnpm --filter @reelforge/agent verify-contracts`
re-derives both from the vendored Aiken blueprints (`packages/agent/contracts`, MIT, Aiken v1.1.23) and
fails unless they hash to the live escrow address and registry policy. ReelForge's own on-chain writes are:
the registry NFT mint (MintAction), `SubmitResult` and `Withdraw` transactions — all built with the
Evolution SDK and evaluated by Blockfrost before signing.

## Packages

| Path | What |
|---|---|
| `packages/agent` | The paid agent: MIP-003 API, x402 escrow routes, Sokosumi coworker runtime, settlement watcher + collector, registry scripts |
| `packages/higgsfield` | Server-only Higgsfield client + response adapter (credentials never reach the browser) |
| `packages/web` | ReelForge site: generate → "Edit video" → Omniclip editor, durable media + project API |
| `packages/editor` | Patched Omniclip build with a postMessage/URL bridge |

## Tech stack (Cardano)

- **x402** — `@x402/core|express|fetch|cardano` **2.26.0** (hackathon pin), `exact` scheme,
  `assetTransferMethod: "masumi"`, hosted Cardano Foundation facilitator (`FACILITATOR_URL`).
- **Masumi** — MIP-003 agentic service API, MIP-004 hashing, registry V2 metadata (Dynamic pricing,
  `Web3CardanoV2` source), seller-signed purchase terms byte-compatible with the Masumi Payment Service
  (verified in `test/masumi.test.ts` with the same Mesh `checkSignature` Sokosumi's buyer node uses).
- **Evolution SDK** `0.5.14` (tx building, the SDK x402 is built on), **Blockfrost** preprod, **Aiken** blueprints (CIP-57).
- **Sokosumi** Core API — coworker runtime with a `coworker_*` key, `masumiPayment` Task events.
- Built with the Cardano Dev Skills (suggest-tooling/x402, build-transaction patterns, review-contract notes).

## Run it

```sh
pnpm install
cp .env.example .env            # fill BLOCKFROST_PROJECT_ID, HIGGSFIELD_API_KEY, SOKOSUMI_API_KEY …
pnpm --filter @reelforge/agent verify-contracts
pnpm --filter @reelforge/agent wallets       # creates SELLER/BUYER mnemonics in .env (never printed)
pnpm --filter @reelforge/agent balances      # fund the printed addresses (dispenser.masumi.network)
# public HTTPS URL (registry + Sokosumi need one):
npx cloudflared tunnel --url http://localhost:8080   # → set PUBLIC_BASE_URL
pnpm --filter @reelforge/agent start
pnpm --filter @reelforge/agent register      # mints the registry NFT, saves MASUMI_AGENT_IDENTIFIER
pnpm --filter @reelforge/agent check-registry
pnpm --filter @reelforge/agent sokosumi setup   # coworker + workspace access + runtime key
```

Try it:

```sh
pnpm --filter @reelforge/agent sokosumi task "a neon city at night, drone push-in"   # paid Sokosumi Task (personal)
pnpm --filter @reelforge/agent sokosumi task org "…"                                 # TOKEN2049 workspace (after approval)
pnpm --filter @reelforge/agent buy "golden hour over Marina Bay"                     # x402 escrow payment (5 tADA)
pnpm --filter @reelforge/agent buy "…" --tusdm                                       # x402 escrow payment (1 tUSDM)
curl $PUBLIC_BASE_URL/jobs                                                            # jobs + tx references
```

The collector withdraws each escrow automatically after its `unlock_time` (~60 min after a Sokosumi
quote, ~50 min after an x402 quote). Refunds: if no result is submitted before `submit_result_time`, the
buyer reclaims via `WithdrawRefund`; disputes go to the escrow's admin multisig.

## Pricing and revisions

Every request is quoted individually (`POST /quote` is free) and the quote is what gets signed into the escrow terms:

```
price_tUSDM = (0.40 base + 0.12 × seconds + complexity surcharge + 0.15 × extra scenes) × resolution factor
price_tADA  = price_tUSDM × 5   (x402 tADA route, minimum 2 tADA)
```

- **Length** 4–15 s (input `duration`, or parsed from the prompt, e.g. "10s").
- **Resolution** 480p ×0.8 · 720p ×1 · 1080p ×1.6 (input `resolution`, or "1080p" in the prompt).
- **Complexity** from word count, scene cuts ("then", "cut to", ";") and features (camera moves, people, text/logos, effects, slow motion): simple +0 · standard +0.25 · complex +0.60.
- A simple 5 s 720p reel is 1 tUSDM / 5 tADA; e.g. a 10 s 1080p multi-scene prompt with effects is 4 tUSDM / 20 tADA.
- All rates are env-tunable (`PRICE_*`). The paid length/resolution are passed to Higgsfield, so buyers get what they paid for.

**Revisions:** one hire covers up to `MAX_ITERATIONS_PER_HIRE` (default **5**) generations — the reel plus 4 revisions.
On Sokosumi, comment on the delivered Task with the changes (or move it back to Ready); ReelForge replies "Revision n/5".
API buyers use `POST /jobs/<job_id>/revisions {"instructions": "…"}`. After the 5th generation ReelForge asks for a rehire
(new Task / new payment; the API returns HTTP 402). Revisions keep the paid specs; the on-chain result hash commits to the
first delivery and each revision's hash is recorded on the job.
## Live proof (Cardano preprod, 2026-10-07)

Seller (ReelForge) `addr_test1qqvgrrs63qmum4kpsmxcqunwv70cycelmx5gtvycs27huh0zyfy7f4d0qgfq59rv2kk5f86372fmh5fapkq29xvw48vscpdmhs`
· escrow `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`
· agent identifier `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1055c4441512c1ae15024b9927c83afb597560b87b2535d275d905f5a4000000`
(registry mint [`594357…`](https://preprod.cardanoscan.io/transaction/594357506a246d6f6d4c35452bddb0c98a447efb009d7a6742a4cfa704680ca7), registry status **Online**)
· Sokosumi coworker **ReelForge** `01a1162d-eedb-70bf-b406-591bb55f785c` (granted in the TOKEN2049 Origins Hackathon 2026 workspace).

| Job | Route | Escrow lock | Result hash on chain (SubmitResult) | Seller collection (Withdraw) | Net to seller |
|---|---|---|---|---|---|
| Sokosumi Task `01a1162e-c617-71ae-9783-396145d28f07` (personal) | coworker `masumiPayment`, 1 tUSDM | [`149588…`](https://preprod.cardanoscan.io/transaction/149588f40ecf57e6519204631cc32c3abc7f758f82688a9407ff577f49e34b2f) | [`e9be96…`](https://preprod.cardanoscan.io/transaction/e9be962c68146895fdcb0818cc162f23bd89ec49bd9ef527d037da70674dd01e) | [`9dedb3…`](https://preprod.cardanoscan.io/transaction/9dedb3fd1e48b83f00bd6f468925a580185ead8a1c801e8c1eab69eb32e49ca8) | **1 tUSDM** (`16a55b2a…0014df10745553444d`); Core receipt `settled: true, Withdrawn` |
| x402 buyer (`pnpm buy`) | x402 `exact` + `masumi`, 5 tADA, hosted facilitator | [`9c9ea4…`](https://preprod.cardanoscan.io/transaction/9c9ea40f0dc23a7dfebd44e2683c31ae582dddd3ca27a603650c12c5af9e4e72) | [`76838f…`](https://preprod.cardanoscan.io/transaction/76838fec6a1216e2f21d1a3939d35c35e122c394ba6a7ef4688ed1d69dc03d79) | [`7b157e…`](https://preprod.cardanoscan.io/transaction/7b157e37a0e3bc95a67284c81a1321060ec69035383beffb35cccf5bbd27225c) | 4.356 tADA (5 − fee) |
| Sokosumi Task `01a11659-73dd-7573-9c3a-7ca4733653de` (TOKEN2049) | coworker, 1 tUSDM | [`c65a30…`](https://preprod.cardanoscan.io/transaction/c65a305951794e08f79d320e46a3a79e32655fb026411d77a0c4204b6a9acf33) | [`0d0248…`](https://preprod.cardanoscan.io/transaction/0d0248960d7a563acd392d705cb8361101df4e0ee2dd098c4040f50f521926d0) | after unlock (13:32 UTC) | pending |
| Sokosumi Task `01a11660-757a-72e4-a538-7259b4710de2` (TOKEN2049) | coworker, 1 tUSDM | [`cb1cd1…`](https://preprod.cardanoscan.io/transaction/cb1cd16a622c02d74c52085bb792f6a9309ae0a78002f3468c0e0c05d0578006) | [`a63a72…`](https://preprod.cardanoscan.io/transaction/a63a7244fd2df4c862965b2a94bbb8c5d96680b0e0899880e4a3c2a378f9a731) | after unlock | pending |

Re-verify independently: `pnpm --filter @reelforge/agent verify-onchain` (every tx + escrow state via Blockfrost)
and `pnpm --filter @reelforge/agent receipt <collectTx>` (seller net receipt from the tx's inputs/outputs).

## Security notes

- Secrets live only in the git-ignored root `.env`; scripts never print mnemonics or keys.
- Every escrow lock is checked field-by-field against the terms ReelForge signed before any work starts
  (`lockMismatch` in `packages/agent/src/chain.ts`); `vested_pay` validates nothing at lock time.
- Preprod only. Mainnet keys never belong in this repo.