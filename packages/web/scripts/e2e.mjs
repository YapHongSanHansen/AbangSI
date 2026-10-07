#!/usr/bin/env node
/**
 * End-to-end proof of the minimal flow in real Chrome (headless):
 *   mock completed Higgsfield generation -> "Edit video" -> clip lands in Omniclip media library + timeline
 *   -> trim (via the editor context) + add text -> export -> MP4 handed back to the site -> ffprobe check.
 *
 * Needs the single-origin server running (pnpm --filter @reelforge/web start:server after a build).
 *   E2E_BASE_URL   default http://localhost:3001
 *   E2E_OUT_DIR    where screenshots / exported mp4 go (default ./e2e-output)
 *   E2E_VIDEO_URL  optional: also open /studio?gen=..&video=<url> (deep link) and check the import
 */
import {chromium} from "playwright"
import {createRequire} from "node:module"
import {spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
const ffprobe = require("ffprobe-static").path
const ffmpeg = require("ffmpeg-static")

const base = (process.env.E2E_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "")
const out = path.resolve(process.env.E2E_OUT_DIR ?? "e2e-output")
fs.mkdirSync(out, {recursive: true})
const log = (...a) => console.log("[e2e]", ...a)
const consoleLog = fs.createWriteStream(path.join(out, "browser-console.log"))

const TRIM_START = 1000, TRIM_END = 3000, TEXT = "ReelForge edit"

const browser = await chromium.launch({
	channel: process.env.E2E_CHANNEL ?? "chrome",
	headless: process.env.E2E_HEADFUL ? false : true,
	args: ["--autoplay-policy=no-user-gesture-required"],
})
const context = await browser.newContext({viewport: {width: 1600, height: 950}, acceptDownloads: true})
const page = await context.newPage()
page.on("console", m => consoleLog.write(`[${m.type()}] ${m.text()}\n`))
page.on("pageerror", e => consoleLog.write(`[pageerror] ${e.message}\n`))

async function editorFrame() {
	const handle = await page.waitForSelector("[data-testid=editor-frame]", {timeout: 60_000})
	const frame = await handle.contentFrame()
	await frame.waitForFunction(() => !!window.reelforge, null, {timeout: 120_000})
	return frame
}

function probe(file) {
	const r = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_frames,duration", "-of", "json", file], {encoding: "utf8"})
	if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
	return JSON.parse(r.stdout)
}

let failures = 0
const check = (ok, msg) => { log(ok ? "PASS" : "FAIL", msg); if (!ok) failures++ }

try {
	// 1. generate page with a mock completed generation
	await page.goto(`${base}/`)
	await page.click("[data-testid=generate]")
	await page.waitForSelector("[data-testid=result][data-status=completed]", {timeout: 60_000})
	check(true, "mock generation completed and the result shows")
	await page.screenshot({path: path.join(out, "1-result-with-edit-button.png")})

	// 2. Edit video -> studio -> editor auto-imports into media library + timeline
	const t0 = Date.now()
	await page.click("[data-testid=edit-video]")
	const frame = await editorFrame()
	await frame.waitForFunction(() => {
		const ctx = window.reelforge.context()
		return ctx && ctx.state.effects.some(e => e.kind === "video")
	}, null, {timeout: 120_000})
	const imported = await frame.evaluate(() => {
		const ctx = window.reelforge.context()
		const v = ctx.state.effects.find(e => e.kind === "video")
		return {
			projectId: ctx.state.projectId,
			videoEffects: ctx.state.effects.filter(e => e.kind === "video").length,
			effect: {id: v.id, start: v.start, end: v.end, duration: v.duration, track: v.track, file_hash: v.file_hash},
			inLibrary: !!ctx.controllers.media.get(v.file_hash),
			settings: ctx.state.settings,
			timebase: ctx.state.timebase,
			tracks: ctx.state.tracks.length,
		}
	})
	log("imported in", Date.now() - t0, "ms:", JSON.stringify(imported))
	check(imported.videoEffects === 1, "exactly one video clip on the timeline")
	check(imported.inLibrary, "clip's file is in the Omniclip media library (IndexedDB)")
	await page.waitForTimeout(1500)
	await page.screenshot({path: path.join(out, "2-editor-imported.png")})

	// timeline DOM shows the clip
	const timelineClips = await frame.evaluate(() => {
		const find = (root, sel, acc = []) => {
			root.querySelectorAll("*").forEach(el => { if (el.matches?.(sel)) acc.push(el); if (el.shadowRoot) find(el.shadowRoot, sel, acc) })
			return acc
		}
		return find(document, "omni-timeline").length
	})
	check(timelineClips >= 1, "omni-timeline element rendered")

	// 3. trim + text through the exposed editor context (same actions the UI uses)
	const edited = await frame.evaluate(async ({TRIM_START, TRIM_END, TEXT}) => {
		const rf = window.reelforge
		const ctx = rf.context()
		const v = ctx.state.effects.find(e => e.kind === "video")
		await rf.trimClip(v.id, TRIM_START, TRIM_END)
		const t = await rf.addText(TEXT, {startMs: 0, durationMs: 1500})
		const s = rf.context().state
		const v2 = s.effects.find(e => e.id === v.id)
		return {video: {start: v2.start, end: v2.end, pos: v2.start_at_position}, text: {id: t.id, track: t.track, start: t.start_at_position, end: t.end}, timelineMs: rf.timelineDuration(s.effects), undoSteps: rf.context().history.past.length}
	}, {TRIM_START, TRIM_END, TEXT})
	log("edited:", JSON.stringify(edited))
	check(edited.video.start === TRIM_START && edited.video.end === TRIM_END, "clip trimmed to 1.0-3.0 s of the source")
	check(edited.timelineMs === TRIM_END - TRIM_START, `timeline duration is ${edited.timelineMs} ms`)

	// undo / redo round trip on the text
	const undo = await frame.evaluate(() => {
		const ctx = window.reelforge.context()
		// undo until the text clip disappears (adding text = add + pivot steps), then redo the same number of steps
		const before = ctx.state.effects.length
		let steps = 0
		while (ctx.state.effects.length === before && steps < 5) { ctx.undo(); steps++ }
		const afterUndo = ctx.state.effects.length
		for (let i = 0; i < steps; i++) ctx.redo()
		return {before, afterUndo, afterRedo: ctx.state.effects.length, steps}
	})
	check(undo.afterUndo < undo.before && undo.afterRedo === undo.before, `undo/redo works (${JSON.stringify(undo)})`)

	await frame.evaluate(() => { const c = window.reelforge.context(); c.actions.set_timecode(500, {omit: true}); c.controllers.compositor.compose_effects(c.state.effects, 500) })
	await page.waitForTimeout(1500)
	await page.screenshot({path: path.join(out, "3-editor-trimmed-with-text.png")})

	// 4. export via the site's Export button -> bridge -> site -> server copy
	const te = Date.now()
	await page.click("[data-testid=export]")
	await page.waitForFunction(() => window.__reelforgeExport?.assetId, null, {timeout: 300_000, polling: 500})
	const exp = await page.evaluate(() => window.__reelforgeExport)
	log("export finished in", Date.now() - te, "ms:", JSON.stringify(exp))
	await page.screenshot({path: path.join(out, "4-export-ready.png")})

	const res = await fetch(`${base}${exp.mediaPath}`)
	const mp4 = path.join(out, "exported.mp4")
	fs.writeFileSync(mp4, Buffer.from(await res.arrayBuffer()))
	const info = probe(mp4)
	fs.writeFileSync(path.join(out, "exported.ffprobe.json"), JSON.stringify(info, null, 2))
	const v = info.streams.find(s => s.codec_type === "video")
	const a = info.streams.find(s => s.codec_type === "audio")
	const dur = Number(info.format.duration)
	log("ffprobe:", JSON.stringify({format: info.format, video: v, audio: a}))
	check(v?.codec_name === "h264", `video codec h264 (${v?.codec_name} ${v?.profile})`)
	check(info.format.format_name.includes("mp4"), `container ${info.format.format_name}`)
	check(Math.abs(dur - (TRIM_END - TRIM_START) / 1000) <= 0.25, `duration ${dur}s ~= ${(TRIM_END - TRIM_START) / 1000}s (trimmed)`)
	check(v?.width === imported.settings.width && v?.height === imported.settings.height, `resolution ${v?.width}x${v?.height}`)

	// frame grab to show the text overlay is burned in
	spawnSync(ffmpeg, ["-y", "-v", "error", "-ss", "0.5", "-i", mp4, "-frames:v", "1", path.join(out, "exported-frame-0.5s.png")])
	spawnSync(ffmpeg, ["-y", "-v", "error", "-ss", "1.8", "-i", mp4, "-frames:v", "1", path.join(out, "exported-frame-1.8s.png")])

	// 5. reload: project restored from local storage, generated clip not imported twice
	await page.reload()
	const frame2 = await editorFrame()
	await frame2.waitForFunction(() => window.reelforge.context()?.controllers.compositor.recreated, null, {timeout: 120_000})
	await page.waitForTimeout(3000)
	const afterReload = await frame2.evaluate(() => {
		const s = window.reelforge.context().state
		return {videos: s.effects.filter(e => e.kind === "video").length, texts: s.effects.filter(e => e.kind === "text").length, settings: s.settings}
	})
	check(afterReload.videos === 1 && afterReload.texts === 1, `reload keeps the edit and does not re-import (${JSON.stringify(afterReload)})`)

	// 6. "another version arrived": add as new clip, then replace the selected clip
	const videoIds = () => frame2.evaluate(() => window.reelforge.context().state.effects.filter(e => e.kind === "video").map(e => e.id))
	const before = await videoIds()
	await page.click("text=New version")
	await page.click("[data-testid=new-version-dialog] button.primary")
	await page.waitForSelector("[data-testid=nv-append]", {timeout: 60_000})
	await page.click("[data-testid=nv-append]")
	await frame2.waitForFunction(n => window.reelforge.context().state.effects.filter(e => e.kind === "video").length === n, before.length + 1, {timeout: 60_000})
	const afterAppend = await videoIds()
	check(afterAppend.length === before.length + 1, `"Add as new clip" appended a clip (${before.length} -> ${afterAppend.length} video clips)`)
	const appended = afterAppend.find(id => !before.includes(id))
	await frame2.evaluate(id => { const c = window.reelforge.context(); c.controllers.timeline.set_selected_effect(c.state.effects.find(e => e.id === id), c.state) }, appended)
	await page.waitForTimeout(2000) // selection is reported to the site every 1.5 s
	await page.click("text=New version")
	await page.click("[data-testid=new-version-dialog] button.primary")
	await page.waitForSelector("[data-testid=nv-replace]:not([disabled])", {timeout: 60_000})
	await page.click("[data-testid=nv-replace]")
	await frame2.waitForFunction(id => !window.reelforge.context().state.effects.some(e => e.id === id), appended, {timeout: 60_000})
	const afterReplace = await videoIds()
	check(afterReplace.length === afterAppend.length && !afterReplace.includes(appended), `"Replace selected clip" swapped the selected clip (${afterReplace.length} video clips)`)
	const library = await frame2.evaluate(() => window.reelforge.context().controllers.media.size)
	check(library >= 1, `originals stay in the media library (${library} file(s))`)
	await page.screenshot({path: path.join(out, "6-new-version.png")})

	// 7. save to the server, reopen in a FRESH browser profile (no local storage / IndexedDB)
	await page.click("[data-testid=save-project]")
	await page.waitForFunction(() => document.querySelector("[data-testid=save-state]")?.textContent?.startsWith("Saved"), null, {timeout: 120_000})
	const savedState = await frame2.evaluate(() => window.reelforge.context().state.effects.map(e => e.kind).sort().join(","))
	const ctx2 = await browser.newContext({viewport: {width: 1600, height: 950}})
	const page2 = await ctx2.newPage()
	await page2.goto(`${base}/studio?project=${encodeURIComponent(imported.projectId)}`)
	const h2 = await page2.waitForSelector("[data-testid=editor-frame]", {timeout: 60_000})
	const f2 = await h2.contentFrame()
	await f2.waitForFunction(() => window.reelforge?.context()?.state.effects.length > 0, null, {timeout: 180_000})
	await page2.waitForTimeout(2000)
	const reopened = await f2.evaluate(() => {
		const c = window.reelforge.context()
		return {kinds: c.state.effects.map(e => e.kind).sort().join(","), media: c.controllers.media.size, settings: c.state.settings,
			allFiles: c.state.effects.filter(e => e.file_hash).every(e => c.controllers.media.get(e.file_hash))}
	})
	check(reopened.kinds === savedState && reopened.allFiles, `project reopened in a fresh browser with its media (${JSON.stringify(reopened)})`)
	await page2.screenshot({path: path.join(out, "7-reopened-fresh-browser.png")})
	await ctx2.close()

	// 8. error states
	const badHost = "https" + "://evil.example.com/a.mp4"
	for (const [url, expect] of [
		[`/studio?gen=mock-fail-${Date.now()}&mock=1`, "Generation failed"],
		[`/studio?gen=mock-expired-${Date.now()}`, "Video URL expired"],
		[`/studio?gen=evil1&video=${encodeURIComponent(badHost)}`, "Video host not allowed"],
		[`/studio?gen=does-not-exist-${Date.now()}`, ""],
	]) {
		await page.goto(`${base}${url}`)
		const el = await page.waitForSelector("[data-testid=studio-error]", {timeout: 60_000})
		const text = (await el.textContent()) ?? ""
		check(!expect || text.includes(expect), `error state for ${url.split("&")[0]}: "${text.slice(0, 90)}"`)
	}
	await page.screenshot({path: path.join(out, "8-error-state.png")})

	// 9. optional deep link
	if (process.env.E2E_VIDEO_URL) {
		const gen = `deeplink-${Date.now().toString(36)}`
		await page.goto(`${base}/studio?gen=${gen}&video=${encodeURIComponent(process.env.E2E_VIDEO_URL)}`)
		const f3 = await editorFrame()
		await f3.waitForFunction(() => window.reelforge.context()?.state.effects.some(e => e.kind === "video"), null, {timeout: 180_000})
		const dl = await f3.evaluate(() => { const s = window.reelforge.context().state; return {videos: s.effects.filter(e => e.kind === "video").length, settings: s.settings} })
		check(dl.videos === 1, `deep link imported the external reel (${JSON.stringify(dl)})`)
		await page.waitForTimeout(1500)
		await page.screenshot({path: path.join(out, "5-deeplink.png")})
	}
} catch (e) {
	failures++
	log("ERROR", e.message)
	await page.screenshot({path: path.join(out, "error.png")}).catch(() => {})
} finally {
	await browser.close()
	consoleLog.end()
}
log(failures ? `${failures} check(s) FAILED` : "ALL CHECKS PASSED", "->", out)
process.exit(failures ? 1 : 0)