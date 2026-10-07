import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"

import {adaptHiggsfieldResponse} from "../src/adapter.ts"
import {buildModelInput, pickModel, DEFAULT_TEXT_TO_VIDEO_MODEL} from "../src/models.ts"
import {createVideo, getGeneration} from "../src/client.ts"

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

test("v2 completed status response", () => {
	const g = adaptHiggsfieldResponse(fixture("v2-completed.json"))
	assert.equal(g.generationId, "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff")
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://cdn.example.com/video.mp4")
	assert.equal(g.error, undefined)
})

test("v2 queued / in_progress", () => {
	assert.equal(adaptHiggsfieldResponse(fixture("v2-queued.json")).status, "queued")
	const p = adaptHiggsfieldResponse(fixture("v2-in-progress.json"))
	assert.equal(p.status, "processing")
	assert.equal(p.rawStatus, "in_progress")
	assert.equal(p.videoUrl, undefined)
})

test("v2 failed and nsfw map to failed with a message", () => {
	const f = adaptHiggsfieldResponse(fixture("v2-failed.json"))
	assert.equal(f.status, "failed")
	assert.equal(f.error, "Model backend error")
	const n = adaptHiggsfieldResponse(fixture("v2-nsfw.json"))
	assert.equal(n.status, "failed")
	assert.equal(n.rawStatus, "nsfw")
	assert.match(n.error!, /moderation/)
})

test("webhook envelope with payload.video.url", () => {
	const g = adaptHiggsfieldResponse(fixture("webhook-completed.json"))
	assert.equal(g.generationId, "9417a243-e457-4075-895b-b68f3cda5303")
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://cdn.example.com/generated-video.mp4")
})

test("v1 job-set: jobs[0].results.raw.url + min thumbnail", () => {
	const g = adaptHiggsfieldResponse(fixture("v1-jobset-completed.json"))
	assert.equal(g.generationId, "js_123")
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://cdn.example.com/raw.mp4")
	assert.equal(g.thumbnailUrl, "https://cdn.example.com/thumb.webp")
})

test("v1 job-set in progress / failed jobs", () => {
	const running = adaptHiggsfieldResponse({id: "js_1", jobs: [{id: "j", status: "in_progress", results: null}]})
	assert.equal(running.status, "processing")
	const failed = adaptHiggsfieldResponse({id: "js_2", jobs: [{id: "j", status: "nsfw", results: null}]})
	assert.equal(failed.status, "failed")
	assert.match(failed.error!, /nsfw/)
})

test("camelCase + data envelope + videos[] + state", () => {
	const g = adaptHiggsfieldResponse(fixture("camel-videos-array.json"))
	assert.equal(g.generationId, "gen_42")
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://cdn.example.com/a.mp4")
	assert.equal(g.thumbnailUrl, "https://cdn.example.com/a.jpg")
})

test("assorted shapes: video as string, video_url, videoUrl, status casing", () => {
	assert.equal(adaptHiggsfieldResponse({request_id: "r1", status: "COMPLETED", video: "https://x.test/v.mp4"}).videoUrl, "https://x.test/v.mp4")
	assert.equal(adaptHiggsfieldResponse({id: "r2", status: "done", video_url: "https://x.test/v2.mp4"}).videoUrl, "https://x.test/v2.mp4")
	const c = adaptHiggsfieldResponse({generationId: "r3", status: "Processing", videoUrl: null})
	assert.equal(c.status, "processing")
	assert.equal(c.generationId, "r3")
})

test("completed without a video URL is reported as failed (no silent success)", () => {
	const g = adaptHiggsfieldResponse({request_id: "r4", status: "completed", images: [{url: "https://x.test/i.png"}]})
	assert.equal(g.status, "failed")
	assert.match(g.error!, /no video URL/)
})

test("deep search finds nested video url when status missing", () => {
	const g = adaptHiggsfieldResponse({id: "r5", output: {files: [{kind: "video", location: {href: "https://x.test/deep.mp4?sig=1"}}]}})
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://x.test/deep.mp4?sig=1")
})

test("error bodies and garbage input", () => {
	const nf = adaptHiggsfieldResponse({detail: "Not found"}, "fallback-id")
	assert.equal(nf.status, "failed")
	assert.equal(nf.error, "Not found")
	assert.equal(nf.generationId, "fallback-id")
	assert.equal(adaptHiggsfieldResponse(null).status, "failed")
	assert.equal(adaptHiggsfieldResponse("not json").status, "failed")
	assert.equal(adaptHiggsfieldResponse(JSON.stringify({request_id: "s", status: "queued"})).status, "queued")
})

test("SDK JobSet shape (jobs[0].results.raw.url, min === raw)", () => {
	const jobSet = {id: "req-9", jobs: [{id: "req-9", status: "completed", results: {raw: {url: "https://cdn.example.com/s.mp4", type: "video"}, min: {url: "https://cdn.example.com/s.mp4", type: "video"}}}]}
	const g = adaptHiggsfieldResponse(jobSet)
	assert.equal(g.generationId, "req-9")
	assert.equal(g.status, "completed")
	assert.equal(g.videoUrl, "https://cdn.example.com/s.mp4")
	assert.equal(g.thumbnailUrl, undefined)
})

test("raw is preserved", () => {
	const raw = fixture("v2-completed.json")
	assert.equal(adaptHiggsfieldResponse(raw).raw, raw)
})

test("model input builder only sends supported fields", () => {
	assert.equal(pickModel(undefined, undefined), "bytedance/seedance-2.5/text-to-video")
	assert.deepEqual(buildModelInput(DEFAULT_TEXT_TO_VIDEO_MODEL, {prompt: "p", aspectRatio: "9:16"}),
		{prompt: "p", duration: 5, resolution: "720p", output_format: "mp4", generate_audio: true, aspect_ratio: "9:16"})
	assert.equal(buildModelInput(DEFAULT_TEXT_TO_VIDEO_MODEL, {prompt: "p", durationSeconds: 60}).duration, 30)
	assert.deepEqual(buildModelInput("minimax/hailuo-2.3/standard/text-to-video", {prompt: "p", durationSeconds: 5, aspectRatio: "9:16"}), {prompt: "p", duration: 6})
	assert.deepEqual(buildModelInput("lightricks/ltx-2.5/text-to-video/fast", {prompt: "p", durationSeconds: 7, aspectRatio: "9:16"}), {prompt: "p", duration: 6, aspect_ratio: "9:16"})
	assert.throws(() => buildModelInput("kling-video/v2.5-turbo/standard/image-to-video", {prompt: "p"}))
})

test("mock mode never needs credentials", async () => {
	const saved = process.env.HIGGSFIELD_API_KEY
	delete process.env.HIGGSFIELD_API_KEY
	try {
		const {generationId} = await createVideo({prompt: "hello world", model: "mock"})
		assert.match(generationId, /^mock-/)
		const g = await getGeneration(generationId)
		assert.equal(g.status, "completed")
		assert.match(g.videoUrl!, /^https:\/\//)
	} finally {
		if (saved !== undefined) process.env.HIGGSFIELD_API_KEY = saved
	}
})