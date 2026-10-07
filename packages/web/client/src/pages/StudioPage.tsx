import {useCallback, useEffect, useMemo, useRef, useState} from "react"

import {api, pollGeneration, projectIdFor, ApiFailure, type Generation} from "../api"
import {navigate} from "../router"

const EDITOR_BASE: string = import.meta.env.VITE_EDITOR_URL ?? "/editor/"

type Phase =
	| {kind: "resolving", message: string}
	| {kind: "waiting", generation: Generation}
	| {kind: "error", title: string, message: string, retry?: boolean}
	| {kind: "editor"}

interface ExportResult {
	url: string
	size: number
	durationMs: number
	uploaded?: {assetId: string, mediaPath: string}
	uploadError?: string
}

type NewVersion = {status: "form"} | {status: "working", generation?: Generation} | {status: "ready", generationId: string, mediaPath: string} | {status: "error", message: string}

const ERROR_TEXT: Record<string, string> = {
	media_expired: "The generated video URL has expired or was removed.",
	media_inaccessible: "The browser could not download the video (network or cross-origin block).",
	not_a_video: "The URL did not contain a video.",
	import_failed: "The editor could not read this video file.",
	no_selection: "Select the clip to replace in the timeline first, then try again.",
	media_origin_not_allowed: "The editor only loads media from the ReelForge server.",
	webcodecs_unsupported: "Export needs the latest Chrome or Edge (WebCodecs).",
}

function describeApiError(e: unknown): {title: string, message: string} {
	if (e instanceof ApiFailure) {
		const titles: Record<string, string> = {
			generation_failed: "Generation failed",
			generation_not_found: "Generation not found",
			source_expired: "Video URL expired",
			source_unreachable: "Video URL is not reachable",
			host_not_allowed: "Video host not allowed",
			not_a_video: "Not a video",
			not_completed: "Still generating",
		}
		return {title: titles[e.code] ?? "Could not open the video", message: e.message}
	}
	return {title: "Could not open the video", message: String((e as Error)?.message ?? e)}
}

export function StudioPage({search}: {search: string}) {
	const params = useMemo(() => new URLSearchParams(search), [search])
	const gen = params.get("gen") ?? ""
	const videoParam = params.get("video") ?? ""
	const mock = params.get("mock") === "1"
	const projectParam = params.get("project") ?? ""
	const projectId = projectParam || (gen ? projectIdFor(gen) : "")

	const [phase, setPhase] = useState<Phase>({kind: "resolving", message: "Preparing your video..."})
	const [src, setSrc] = useState<string | null>(null)
	const [editorReady, setEditorReady] = useState(false)
	const [imported, setImported] = useState<string | null>(null)
	const [banner, setBanner] = useState<{type: "error" | "info", text: string} | null>(null)
	const [selection, setSelection] = useState<{effectId: string | null, kind: string | null}>({effectId: null, kind: null})
	const [exportResult, setExportResult] = useState<ExportResult | null>(null)
	const [saveState, setSaveState] = useState<{status: "idle" | "saving" | "saved" | "error", at?: string, message?: string}>({status: "idle"})
	const [autosave, setAutosave] = useState(true)
	const [showInfo, setShowInfo] = useState(false)
	const [newVersion, setNewVersion] = useState<NewVersion | null>(null)
	const [nvPrompt, setNvPrompt] = useState("Same scene, warmer light, slower camera")
	const [nvMock, setNvMock] = useState(true)

	const iframe = useRef<HTMLIFrameElement>(null)
	const knownHashes = useRef(new Set<string>())
	const snapshotWaiter = useRef<((data: any) => void) | null>(null)
	const generationIds = useRef(new Set<string>(gen ? [gen] : []))
	const saveTimer = useRef<number | undefined>(undefined)

	const editorUrl = useMemo(() => new URL(EDITOR_BASE, location.href), [])
	const sameOrigin = editorUrl.origin === location.origin
	const mediaUrlFor = useCallback((mediaPath: string) => (sameOrigin ? mediaPath : new URL(mediaPath, location.origin).href), [sameOrigin])

	const postToEditor = useCallback((msg: Record<string, unknown>, transfer: Transferable[] = []) => {
		iframe.current?.contentWindow?.postMessage(msg, editorUrl.origin, transfer)
	}, [editorUrl])

	// 1. resolve the generation into a durable, same-site media URL
	useEffect(() => {
		let cancelled = false
		const ctrl = new AbortController()
		async function run() {
			if (!projectId) {
				setPhase({kind: "error", title: "Nothing to open", message: "Open the studio from a generated video (Edit video) or a saved project."})
				return
			}
			if (!gen) {
				setSrc("")
				setPhase({kind: "editor"})
				return
			}
			try {
				let mediaPath: string
				if (videoParam) {
					setPhase({kind: "resolving", message: "Copying the video to ReelForge storage..."})
					mediaPath = (await api.importFromUrl(gen, videoParam, mock)).mediaPath
				} else {
					setPhase({kind: "resolving", message: "Checking generation status..."})
					const g = await pollGeneration(gen, {mock, signal: ctrl.signal, onUpdate: g => !cancelled && g.status !== "completed" && g.status !== "failed" && setPhase({kind: "waiting", generation: g})})
					if (g.status === "failed") {
						setPhase({kind: "error", title: "Generation failed", message: g.error ?? "The generation failed. No credits are charged for failed generations."})
						return
					}
					setPhase({kind: "resolving", message: "Copying the video to ReelForge storage..."})
					mediaPath = g.durable?.mediaPath ?? (await api.durable(gen, mock)).mediaPath
				}
				if (cancelled) return
				knownHashes.current.add(mediaPath.split("/").pop()!)
				setSrc(mediaPath)
				setPhase({kind: "editor"})
			} catch (e) {
				if (cancelled || (e as Error).name === "AbortError") return
				const d = describeApiError(e)
				setPhase({kind: "error", ...d, retry: true})
			}
		}
		run()
		return () => { cancelled = true; ctrl.abort() }
	}, [gen, videoParam, mock, projectId])

	const iframeSrc = useMemo(() => {
		if (src === null || !projectId) return null
		const q = new URLSearchParams()
		if (src) { q.set("src", mediaUrlFor(src)); q.set("gen", gen) }
		const qs = q.toString()
		return `${editorUrl.href}${qs ? `?${qs}` : ""}#/editor/${encodeURIComponent(projectId)}`
	}, [src, projectId, gen, editorUrl, mediaUrlFor])

	// 2. save / restore projects on the server
	const saveProject = useCallback(async () => {
		if (!editorReady) return
		setSaveState({status: "saving"})
		try {
			const snapshot = await new Promise<any>((resolve, reject) => {
				snapshotWaiter.current = resolve
				postToEditor({type: "reelforge:snapshot-request", knownHashes: [...knownHashes.current]})
				setTimeout(() => reject(new Error("The editor did not answer the save request.")), 30_000)
			})
			const withBytes = snapshot.media.filter((m: any) => m.buffer)
			const {present} = withBytes.length ? await api.checkMedia(withBytes.map((m: any) => m.hash)) : {present: [] as string[]}
			for (const m of withBytes) {
				if (!present.includes(m.hash)) {
					const up = await api.uploadMedia(m.buffer, m.type || "application/octet-stream", m.name, {projectId})
					if (up.assetId !== m.hash) console.warn("[studio] uploaded asset id differs from editor hash", up.assetId, m.hash)
				}
				knownHashes.current.add(m.hash)
			}
			const res = await api.saveProject(projectId, {
				name: snapshot.state?.projectName,
				state: snapshot.state,
				settings: snapshot.settings,
				imports: snapshot.imports,
				media: snapshot.media.map((m: any) => ({hash: m.hash, name: m.name, type: m.type, kind: m.kind})),
				generationIds: [...generationIds.current],
			})
			setSaveState({status: "saved", at: res.updatedAt})
		} catch (e) {
			setSaveState({status: "error", message: (e as Error).message})
		}
	}, [editorReady, postToEditor, projectId])

	const saveRef = useRef(saveProject)
	saveRef.current = saveProject
	const autosaveRef = useRef(autosave)
	autosaveRef.current = autosave

	// 3. editor -> site messages
	useEffect(() => {
		async function onMessage(event: MessageEvent) {
			if (event.origin !== editorUrl.origin || event.source !== iframe.current?.contentWindow) return
			const data = event.data
			if (!data || typeof data.type !== "string" || !data.type.startsWith("reelforge:")) return
			switch (data.type) {
				case "reelforge:ready": {
					setEditorReady(true)
					let project = null
					if (!data.hasLocalProject) {
						try { project = await api.getProject(projectId) } catch { project = null }
					}
					for (const m of project?.media ?? []) knownHashes.current.add(m.hash)
					postToEditor({
						type: "reelforge:init",
						project: project ? {...project, media: project.media.map(m => ({...m, url: mediaUrlFor(m.mediaPath ?? `/api/media/${m.hash}`)}))} : null,
					})
					break
				}
				case "reelforge:imported":
					setImported(data.generationId)
					generationIds.current.add(data.generationId)
					if (data.hash) knownHashes.current.add(data.hash)
					setBanner({type: "info", text: data.skipped ? "This video is already in the project." : `Imported into the media library and timeline (${(data.durationMs / 1000).toFixed(1)} s clip).`})
					break
				case "reelforge:error":
					setBanner({type: "error", text: ERROR_TEXT[data.code] ?? data.message ?? "Editor error"})
					if (data.request === "import" && newVersion?.status !== "ready") setImported(i => i ?? "error")
					break
				case "reelforge:selection":
					setSelection({effectId: data.effectId, kind: data.kind})
					break
				case "reelforge:changed":
					if (autosaveRef.current) {
						clearTimeout(saveTimer.current)
						saveTimer.current = window.setTimeout(() => saveRef.current(), 2500)
					}
					break
				case "reelforge:snapshot":
					snapshotWaiter.current?.(data)
					snapshotWaiter.current = null
					break
				case "reelforge:exported": {
					const blob = new Blob([data.buffer], {type: "video/mp4"})
					const url = URL.createObjectURL(blob)
					const result: ExportResult = {url, size: data.size, durationMs: data.durationMs}
					setExportResult(result)
					;(window as any).__reelforgeExport = {size: data.size, durationMs: data.durationMs, blobUrl: url}
					try {
						const up = await api.uploadMedia(blob, "video/mp4", `${projectId}-edit.mp4`, {kind: "export", projectId})
						setExportResult({...result, uploaded: {assetId: up.assetId, mediaPath: up.mediaPath}})
						;(window as any).__reelforgeExport = {...(window as any).__reelforgeExport, assetId: up.assetId, mediaPath: up.mediaPath}
					} catch (e) {
						setExportResult({...result, uploadError: (e as Error).message})
					}
					break
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [editorUrl, postToEditor, projectId, mediaUrlFor, newVersion])

	// 4. "another generated version arrived"
	async function startNewVersion() {
		setNewVersion({status: "working"})
		try {
			const id = nvMock ? `mock-v${Date.now().toString(36)}` : (await api.createGeneration({prompt: nvPrompt})).generationId
			const g = await pollGeneration(id, {mock: nvMock, onUpdate: g => setNewVersion({status: "working", generation: g})})
			if (g.status === "failed") return setNewVersion({status: "error", message: g.error ?? "Generation failed."})
			const d = g.durable ?? await api.durable(id, nvMock)
			setNewVersion({status: "ready", generationId: id, mediaPath: d.mediaPath})
		} catch (e) {
			setNewVersion({status: "error", message: describeApiError(e).message})
		}
	}

	function placeNewVersion(mode: "append" | "replace") {
		if (newVersion?.status !== "ready") return
		postToEditor({type: "reelforge:import", url: mediaUrlFor(newVersion.mediaPath), generationId: newVersion.generationId, mode})
		setNewVersion(null)
	}

	const loadingOverlay = phase.kind === "editor" && src && !imported
	const canReplace = selection.kind === "video"

	return (
		<div className="studio">
			<div className="studio-bar">
				<button className="btn ghost" onClick={() => navigate("/")}>&larr; Back</button>
				<div className="studio-title">
					<strong>ReelForge Studio</strong>
					<span className="muted small">{projectId}</span>
				</div>
				<span className="chip" title="Higgsfield returns one finished MP4. It is imported as ONE video clip: text, captions or music the model baked into the video are part of the picture/soundtrack and cannot be edited as layers. Add new text, images or audio on top.">
					Generated video = 1 clip &middot; baked-in text/music not editable
				</span>
				<div className="spacer" />
				<label className="check small"><input type="checkbox" checked={autosave} onChange={e => setAutosave(e.target.checked)} /> Autosave</label>
				<span className={`save-state ${saveState.status}`} data-testid="save-state">
					{saveState.status === "saving" ? "Saving..." : saveState.status === "saved" ? `Saved ${new Date(saveState.at!).toLocaleTimeString()}` : saveState.status === "error" ? `Save failed: ${saveState.message}` : ""}
				</span>
				<button className="btn" disabled={!editorReady} onClick={saveProject} data-testid="save-project">Save project</button>
				<button className="btn" disabled={!editorReady} onClick={() => setNewVersion({status: "form"})}>New version</button>
				<button className="btn primary" disabled={!editorReady} onClick={() => postToEditor({type: "reelforge:export"})} data-testid="export">Export MP4</button>
				<button className="btn ghost" onClick={() => setShowInfo(v => !v)}>?</button>
			</div>

			{banner && (
				<div className={`alert ${banner.type}`} data-testid="studio-banner">
					{banner.text}
					<button className="link" onClick={() => setBanner(null)}>dismiss</button>
				</div>
			)}

			{exportResult && (
				<div className="export-panel" data-testid="export-panel">
					<strong>Export ready</strong>
					<span className="muted small">{(exportResult.size / 1024 / 1024).toFixed(2)} MB &middot; {(exportResult.durationMs / 1000).toFixed(2)} s</span>
					<a className="btn primary" href={exportResult.url} download={`${projectId}-edit.mp4`} data-testid="download-export">Download MP4</a>
					{exportResult.uploaded && <a className="btn" href={exportResult.uploaded.mediaPath} target="_blank" rel="noreferrer">Stored copy</a>}
					{exportResult.uploadError && <span className="warn small">Not stored on server: {exportResult.uploadError}</span>}
					<button className="link" onClick={() => setExportResult(null)}>close</button>
				</div>
			)}

			<div className="studio-body">
				{phase.kind !== "editor" && (
					<div className="studio-state" data-testid="studio-state">
						{phase.kind === "resolving" && <><div className="spinner" /><p>{phase.message}</p></>}
						{phase.kind === "waiting" && <><div className="spinner" /><p>Higgsfield is {phase.generation.status === "queued" ? "queueing" : "generating"} your video...</p><p className="muted small">The editor opens automatically when it is ready.</p></>}
						{phase.kind === "error" && (
							<div className="alert error" data-testid="studio-error">
								<strong>{phase.title}</strong>
								<p>{phase.message}</p>
								<div className="row">
									{phase.retry && <button className="btn" onClick={() => location.reload()}>Retry</button>}
									<button className="btn" onClick={() => navigate("/")}>Back to create</button>
								</div>
							</div>
						)}
					</div>
				)}
				{phase.kind === "editor" && iframeSrc && (
					<>
						<iframe ref={iframe} className="editor-frame" src={iframeSrc} title="ReelForge Studio editor" allow="fullscreen; clipboard-read; clipboard-write" data-testid="editor-frame" />
						{loadingOverlay && <div className="frame-overlay"><div className="spinner" /><p>Opening the editor and importing your video...</p></div>}
					</>
				)}
				{showInfo && <InfoDrawer onClose={() => setShowInfo(false)} />}
			</div>

			{newVersion && (
				<div className="modal-backdrop">
					<div className="modal" role="dialog" aria-label="New version" data-testid="new-version-dialog">
						{newVersion.status === "form" && (
							<>
								<h3>Generate another version</h3>
								<textarea rows={3} value={nvPrompt} onChange={e => setNvPrompt(e.target.value)} />
								<label className="check"><input type="checkbox" checked={nvMock} onChange={e => setNvMock(e.target.checked)} /> Mock (no credits)</label>
								<div className="row"><button className="btn primary" onClick={startNewVersion}>Generate</button><button className="btn" onClick={() => setNewVersion(null)}>Cancel</button></div>
							</>
						)}
						{newVersion.status === "working" && <><div className="spinner" /><p>Generating new version{newVersion.generation ? ` (${newVersion.generation.status})` : ""}...</p></>}
						{newVersion.status === "error" && <><div className="alert error">{newVersion.message}</div><button className="btn" onClick={() => setNewVersion(null)}>Close</button></>}
						{newVersion.status === "ready" && (
							<>
								<h3>New version ready</h3>
								<p className="muted">Your current edit is kept. The original files stay in the media library either way.</p>
								<div className="row">
									<button className="btn primary" onClick={() => placeNewVersion("append")} data-testid="nv-append">Add as new clip</button>
									<button className="btn" disabled={!canReplace} onClick={() => placeNewVersion("replace")} data-testid="nv-replace">Replace selected clip</button>
									<button className="btn ghost" onClick={() => setNewVersion(null)}>Later</button>
								</div>
								{!canReplace && <p className="muted small">To replace, first select a video clip in the timeline.</p>}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	)
}

function InfoDrawer({onClose}: {onClose: () => void}) {
	return (
		<aside className="info-drawer">
			<button className="link" onClick={onClose}>close</button>
			<h3>Editing in ReelForge Studio</h3>
			<ul>
				<li>Your Higgsfield video is one clip. Text, captions or music the model rendered into it cannot be edited separately.</li>
				<li>Trim by dragging clip edges; split with the scissors; drag clips to rearrange; Ctrl+Z / Ctrl+Shift+Z for undo/redo.</li>
				<li>Add text, images and audio from the left panel; transitions go between two adjacent clips.</li>
				<li>Export renders in your browser (Chrome/Edge). Keep this tab visible while exporting.</li>
			</ul>
			<a href="/about-editing" onClick={e => { e.preventDefault(); navigate("/about-editing") }}>What is supported natively vs. custom</a>
		</aside>
	)
}