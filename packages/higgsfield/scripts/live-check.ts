/**
 * Live sanity check against the real Higgsfield API. Never prints the API key.
 *   node --experimental-strip-types scripts/live-check.ts             -> auth check + free price estimate
 *   node --experimental-strip-types scripts/live-check.ts --generate  -> ALSO starts ONE paid generation
 *                                                                        (default model, 5s, 720p, 9:16)
 * (scripts only: the package itself never loads .env)
 */
import {readFileSync, existsSync, writeFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import path from "node:path"

import {getGeneration, estimateVideo, createVideo, waitForVideo, HiggsfieldError, DEFAULT_TEXT_TO_VIDEO_MODEL} from "../src/index.ts"

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env")
if (!process.env.HIGGSFIELD_API_KEY && existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const m = /^HIGGSFIELD_API_KEY=(.*)$/.exec(line)
		if (m) process.env.HIGGSFIELD_API_KEY = m[1].trim().replace(/^["']|["']$/g, "")
	}
}

try {
	await getGeneration("00000000-0000-4000-8000-000000000000")
	console.log("auth: unexpected success for a fake id")
} catch (e) {
	const err = e as HiggsfieldError
	console.log(`auth: status lookup of fake id -> ${err.httpStatus} ${err.code} (${err.code === "not_found" ? "credentials ACCEPTED" : "check credentials"})`)
}

const input = {prompt: "A paper boat drifting on a calm lake at sunrise, gentle camera push-in, vertical framing", durationSeconds: 5, aspectRatio: "9:16" as const}
const est = await estimateVideo(input)
console.log(`estimate (${DEFAULT_TEXT_TO_VIDEO_MODEL}, 5s 720p 9:16): ${est.credits} credits / $${est.usd}`)

if (process.argv.includes("--generate")) {
	const t0 = Date.now()
	const created = await createVideo(input)
	console.log("created:", created.generationId, "initial raw:", JSON.stringify(created.raw))
	const done = await waitForVideo(created.generationId, {
		pollMs: 5000,
		timeoutMs: 15 * 60_000,
		onUpdate: g => console.log(`  +${Math.round((Date.now() - t0) / 1000)}s ${g.rawStatus ?? g.status}`),
	})
	const wall = Math.round((Date.now() - t0) / 1000)
	console.log("final adapted:", JSON.stringify({...done, raw: undefined}))
	console.log("final raw:", JSON.stringify(done.raw))
	console.log(`total wall time: ${wall}s`)
	if (done.videoUrl) {
		const r = await fetch(done.videoUrl, {headers: {Origin: "http://localhost:5174", Range: "bytes=0-1023"}})
		console.log("video url host:", new URL(done.videoUrl).host, "| GET status", r.status, "| content-type", r.headers.get("content-type"),
			"| ACAO", r.headers.get("access-control-allow-origin"), "| content-range", r.headers.get("content-range"))
	}
	const out = process.env.LIVE_RESULT_FILE
	if (out) writeFileSync(out, JSON.stringify({generationId: created.generationId, wallSeconds: wall, adapted: {...done, raw: undefined}, raw: done.raw}, null, 2))
}