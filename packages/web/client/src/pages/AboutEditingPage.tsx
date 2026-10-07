const NATIVE: [string, string][] = [
	["Preview, play / pause, scrub", "Omniclip media player + playhead (PIXI canvas)"],
	["Trim", "Drag clip edges on the timeline (frame-snapped)"],
	["Split", "Scissors tool splits the selected clip at the playhead"],
	["Rearrange clips", "Drag clips between positions and tracks; add tracks"],
	["Text", "Text panel: fonts, size, colour, stroke, shadow, gradients; position on canvas"],
	["Import images / audio", "Media panel (stored in the browser's IndexedDB)"],
	["Transitions", "GL transitions between two adjacent clips on the same track"],
	["Filters & animations", "Per-clip filters and in/out animations"],
	["Undo / redo", "Toolbar buttons, Ctrl+Z / Ctrl+Shift+Z (64 steps)"],
	["Export MP4", "WebCodecs H.264 encode + ffmpeg.wasm mux (Chrome / Edge)"],
	["Local project list", "Projects persist in this browser (localStorage + IndexedDB)"],
]

const CUSTOM: [string, string][] = [
	["Higgsfield adapter", "Normalises several response shapes (v2 status, webhook envelope, v1 job-sets, camelCase) into one format"],
	["Durable media copies", "Server downloads the generated MP4, stores it by sha256 and serves it same-site with Range support; the original is never modified"],
	["Auto-import", "Bridge imports the video into the media library AND the timeline, once per project and generation"],
	["Edit video button and Studio page", "Site shell, loading, failed, expired and inaccessible states, deep link /studio?gen=&video="],
	["New version dialog", "Add the new generation as a new clip or replace the selected clip"],
	["Server-side projects", "Save and reopen projects including their media (media re-downloaded from the server in a new browser)"],
	["Export handoff", "Exported MP4 is passed to the site for download and stored on the server"],
	["Settings persistence", "Resolution, fps and bitrate are saved per project (upstream resets them on reload)"],
	["CapCut-style layout", "Tools left, preview centre, export/settings right, timeline bottom"],
	["Fit to generated video", "Canvas size and fps follow the first imported generation (e.g. 720x1280 for 9:16)"],
]

const LIMITS = [
	"Export needs WebCodecs: latest desktop Chrome or Edge. Firefox/Safari can edit but not export reliably.",
	"Export is rendered frame-by-frame in the tab: keep the tab visible (background tabs pause rendering).",
	"Baked-in text or music from the AI model is part of the video and cannot be edited as a layer.",
	"Omniclip shortens imported clips by 200 ms (upstream safety margin against decoder stalls at the last frame).",
	"Local projects live in this browser; use Save project to keep them on the server.",
]

export function AboutEditingPage() {
	return (
		<div className="page">
			<section className="card">
				<h1>Editing in ReelForge Studio</h1>
				<p className="muted">The editor is <a href="https://github.com/omni-media/omniclip" target="_blank" rel="noreferrer">Omniclip</a> v1.1.3 (MIT), embedded in ReelForge. This is an honest list of what comes from Omniclip and what we built around it.</p>
				<div className="two-col">
					<div>
						<h2>Native Omniclip features</h2>
						<table className="table"><tbody>{NATIVE.map(([a, b]) => <tr key={a}><td>{a}</td><td className="muted">{b}</td></tr>)}</tbody></table>
					</div>
					<div>
						<h2>Built by ReelForge</h2>
						<table className="table"><tbody>{CUSTOM.map(([a, b]) => <tr key={a}><td>{a}</td><td className="muted">{b}</td></tr>)}</tbody></table>
					</div>
				</div>
				<h2>Known limitations</h2>
				<ul>{LIMITS.map(l => <li key={l}>{l}</li>)}</ul>
			</section>
		</div>
	)
}