import {test, before, after} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import type {Server} from "node:http"

const port = 39000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
process.env.MEDIA_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rf-media-"))
process.env.WEB_PUBLIC_URL = base
process.env.IMPORT_ALLOWED_HOSTS = "allowed.example"
process.env.HIGGSFIELD_WEBHOOK_TOKEN = "t0ken"

let server: Server
let sampleSha = ""

before(async () => {
	const {createApp} = await import("../src/app.ts")
	const {config} = await import("../src/config.ts")
	sampleSha = crypto.createHash("sha256").update(fs.readFileSync(config.mockSample)).digest("hex")
	await new Promise<void>(r => { server = createApp().listen(port, "127.0.0.1", () => r()) })
})
after(() => {
	server?.close()
	fs.rmSync(process.env.MEDIA_STORE_DIR!, {recursive: true, force: true})
})

const j = async (p: string, init?: RequestInit) => {
	const r = await fetch(base + p, init)
	return {status: r.status, headers: r.headers, body: await r.json().catch(() => null) as any}
}
const post = (p: string, body?: unknown) => j(p, {method: "POST", headers: {"Content-Type": "application/json"}, body: body === undefined ? undefined : JSON.stringify(body)})

test("health", async () => {
	const r = await j("/api/health")
	assert.equal(r.status, 200)
	assert.equal(r.body.ok, true)
	assert.ok(!JSON.stringify(r.body).includes(process.env.HIGGSFIELD_API_KEY || "@@no-key@@"), "never leaks the key")
})

test("mock generation is completed with a video url", async () => {
	const r = await j("/api/generations/mock-abc")
	assert.equal(r.status, 200)
	assert.equal(r.body.status, "completed")
	assert.match(r.body.videoUrl, /\/api\/mock\/sample\.mp4$/)
})

test("durable copy is content addressed and idempotent", async () => {
	const a = await post("/api/generations/mock-dur1/durable")
	assert.equal(a.status, 200)
	assert.equal(a.body.assetId, sampleSha)
	assert.equal(a.body.mediaPath, `/api/media/${sampleSha}`)
	assert.equal(a.body.reused, false)
	const b = await post("/api/generations/mock-dur1/durable")
	assert.equal(b.body.reused, true)
	assert.equal(b.body.assetId, sampleSha)
	const g = await j("/api/generations/mock-dur1")
	assert.equal(g.body.durable.assetId, sampleSha)
})

test("media is served with type, CORS and Range support", async () => {
	await post("/api/generations/mock-dur2/durable")
	const full = await fetch(`${base}/api/media/${sampleSha}`, {headers: {Origin: "http://localhost:5174"}})
	assert.equal(full.status, 200)
	assert.equal(full.headers.get("content-type"), "video/mp4")
	assert.equal(full.headers.get("access-control-allow-origin"), "http://localhost:5174")
	assert.equal((await full.arrayBuffer()).byteLength, fs.statSync((await import("../src/config.ts")).config.mockSample).size)
	const part = await fetch(`${base}/api/media/${sampleSha}`, {headers: {Range: "bytes=0-99"}})
	assert.equal(part.status, 206)
	assert.match(part.headers.get("content-range")!, /^bytes 0-99\/\d+$/)
	assert.equal((await part.arrayBuffer()).byteLength, 100)
	const evil = await fetch(`${base}/api/media/${sampleSha}`, {headers: {Origin: "https://evil.example"}})
	assert.equal(evil.headers.get("access-control-allow-origin"), null)
	assert.equal((await j("/api/media/not-a-hash")).status, 400)
	assert.equal((await j(`/api/media/${"0".repeat(64)}`)).status, 404)
})

test("failed / expired / disallowed sources give clear errors", async () => {
	const failed = await post("/api/generations/mock-fail-1/durable")
	assert.equal(failed.status, 409)
	assert.equal(failed.body.error.code, "generation_failed")
	const expired = await post("/api/generations/mock-expired-1/durable")
	assert.equal(expired.status, 410)
	assert.equal(expired.body.error.code, "source_expired")
	const host = await post("/api/imports", {generationId: "x1", videoUrl: "https://not-allowed.example/v.mp4"})
	assert.equal(host.status, 403)
	assert.equal(host.body.error.code, "host_not_allowed")
	const bad = await post("/api/imports", {generationId: "x2", videoUrl: "file:///etc/passwd"})
	assert.equal(bad.status, 400)
	const unreachable = await post("/api/imports", {generationId: "x3", videoUrl: "https://allowed.example/v.mp4"})
	assert.ok([502, 410].includes(unreachable.status), `unreachable -> ${unreachable.status}`)
})

test("uploads + projects require their media", async () => {
	const bytes = crypto.randomBytes(2048)
	const up = await j("/api/media?kind=upload", {method: "POST", headers: {"Content-Type": "image/png", "X-File-Name": "logo.png"}, body: bytes})
	assert.equal(up.status, 201)
	assert.equal(up.body.assetId, crypto.createHash("sha256").update(bytes).digest("hex"))
	const check = await post("/api/media/check", {hashes: [up.body.assetId, "f".repeat(64)]})
	assert.deepEqual(check.body.present, [up.body.assetId])
	assert.equal((await j("/api/media", {method: "POST", headers: {"Content-Type": "text/html"}, body: "<x>"})).status, 415)

	const missing = await post("/api/projects/reel-test", {state: {effects: []}, media: [{hash: "a".repeat(64)}]})
	assert.equal(missing.status, 409)
	assert.deepEqual(missing.body.error.details.missing, ["a".repeat(64)])
	const ok = await post("/api/projects/reel-test", {state: {projectName: "T", effects: []}, settings: {width: 720}, media: [{hash: up.body.assetId, name: "logo.png", type: "image/png"}]})
	assert.equal(ok.status, 200)
	const back = await j("/api/projects/reel-test")
	assert.equal(back.body.state.projectName, "T")
	assert.equal(back.body.media[0].mediaPath, `/api/media/${up.body.assetId}`)
	assert.equal((await j("/api/projects")).body.projects[0].projectId, "reel-test")
	assert.equal((await j("/api/projects/..%2Fetc")).status, 400)
})

test("webhook stores terminal status (token protected, envelope validated)", async () => {
	const body = {request_id: "hf-webhook-1", status: "failed", error: "Generation failed", payload: null}
	assert.equal((await post("/api/higgsfield/webhook", body)).status, 401)
	assert.equal((await post("/api/higgsfield/webhook?token=t0ken", {nope: true})).status, 400)
	assert.equal((await post("/api/higgsfield/webhook?token=t0ken", body)).status, 200)
	const g = await j("/api/generations/hf-webhook-1")
	assert.equal(g.body.status, "failed")
	assert.equal(g.body.error, "Generation failed")
})