import {useEffect, useRef, useState, type FormEvent} from "react"

import {api, pollGeneration, ApiFailure, type Generation} from "../api"
import {navigate} from "../router"

type Scenario = "ok" | "slow" | "fail" | "expired"

const statusLabel: Record<string, string> = {
	queued: "Queued at Higgsfield...",
	processing: "Generating your video...",
	completed: "Ready",
	failed: "Generation failed",
}

export function studioLink(generationId: string, mock: boolean) {
	const q = new URLSearchParams({gen: generationId})
	if (mock) q.set("mock", "1")
	return `/studio?${q}`
}

export function CreatePage() {
	const [prompt, setPrompt] = useState("A paper boat drifting on a calm lake at sunrise, gentle camera push-in")
	const [aspect, setAspect] = useState("9:16")
	const [duration, setDuration] = useState(5)
	const [mock, setMock] = useState(true)
	const [scenario, setScenario] = useState<Scenario>("ok")
	const [existingId, setExistingId] = useState("")
	const [gen, setGen] = useState<Generation | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [health, setHealth] = useState<{higgsfieldConfigured: boolean, videoBackend: string} | null>(null)
	const abort = useRef<AbortController | null>(null)

	useEffect(() => {
		api.health().then(setHealth).catch(() => setHealth(null))
		return () => abort.current?.abort()
	}, [])

	async function track(id: string, isMock: boolean) {
		abort.current?.abort()
		const ctrl = new AbortController()
		abort.current = ctrl
		setError(null)
		setBusy(true)
		try {
			await pollGeneration(id, {mock: isMock, signal: ctrl.signal, onUpdate: g => setGen({...g, mock: g.mock ?? isMock})})
		} catch (e) {
			if ((e as Error).name !== "AbortError") setError(e instanceof ApiFailure ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	async function generate(e: FormEvent) {
		e.preventDefault()
		setGen(null)
		setError(null)
		setBusy(true)
		try {
			if (mock) {
				// mock scenarios are selected by id prefix on the server; no credits are spent
				const id = `mock-${scenario === "ok" ? "" : scenario + "-"}${Date.now().toString(36)}`
				setGen({generationId: id, status: "queued", mock: true})
				await track(id, true)
			} else {
				const {generationId} = await api.createGeneration({prompt, aspectRatio: aspect, durationSeconds: duration})
				setGen({generationId, status: "queued"})
				await track(generationId, false)
			}
		} catch (err) {
			setError(err instanceof ApiFailure ? err.message : String(err))
			setBusy(false)
		}
	}

	const done = gen?.status === "completed"
	const failed = gen?.status === "failed"

	return (
		<div className="page create">
			<section className="card">
				<h1>Create a reel</h1>
				<p className="muted">Generate with Higgsfield, then fine-tune it in the browser editor.</p>
				<form onSubmit={generate} className="form">
					<label>Prompt
						<textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
					</label>
					<div className="row">
						<label>Aspect
							<select value={aspect} onChange={e => setAspect(e.target.value)}>
								<option>9:16</option><option>16:9</option><option>1:1</option>
							</select>
						</label>
						<label>Duration (s)
							<input type="number" min={4} max={10} value={duration} onChange={e => setDuration(Number(e.target.value))} />
						</label>
						<label className="check">
							<input type="checkbox" checked={mock} onChange={e => setMock(e.target.checked)} /> Mock (no credits)
						</label>
						{mock && (
							<label>Simulate
								<select value={scenario} onChange={e => setScenario(e.target.value as Scenario)} data-testid="scenario">
									<option value="ok">completed</option>
									<option value="slow">slow (queued, processing)</option>
									<option value="fail">failed generation</option>
									<option value="expired">expired video URL</option>
								</select>
							</label>
						)}
					</div>
					<button className="btn primary" disabled={busy} data-testid="generate">{busy ? "Working..." : "Generate"}</button>
					{health && !mock && !health.higgsfieldConfigured && <p className="warn">The server has no Higgsfield key configured, use mock mode.</p>}
				</form>
				<details className="open-existing">
					<summary>Open an existing generation id</summary>
					<div className="row">
						<input placeholder="Higgsfield request id" value={existingId} onChange={e => setExistingId(e.target.value)} />
						<button className="btn" type="button" disabled={!existingId} onClick={() => { setGen({generationId: existingId, status: "queued"}); track(existingId, existingId.startsWith("mock-")) }}>Check status</button>
					</div>
				</details>
			</section>

			<section className="card result" data-testid="result" data-status={gen?.status ?? "idle"}>
				<h2>Result</h2>
				{!gen && !error && <div className="placeholder">Your generated video will appear here.</div>}
				{error && <div className="alert error">{error}</div>}
				{gen && (
					<>
						<div className="status-line">
							<span className={`badge ${gen.status}`}>{gen.status}</span>
							<span>{statusLabel[gen.status]}</span>
							<code className="muted small">{gen.generationId}</code>
						</div>
						{(gen.status === "queued" || gen.status === "processing") && <div className="spinner-box"><div className="spinner" /></div>}
						{failed && (
							<div className="alert error" data-testid="gen-error">
								{gen.error ?? "The generation failed."} No credits are charged for failed or moderated generations.
								<div><button className="btn" onClick={e => generate(e as unknown as FormEvent)}>Try again</button></div>
							</div>
						)}
						{done && (
							<div className="result-row">
								<video className="preview" src={gen.durable?.mediaPath ?? gen.videoUrl} controls playsInline muted />
								<div className="result-actions">
									<button className="btn primary big" data-testid="edit-video" onClick={() => navigate(studioLink(gen.generationId, !!gen.mock))}>
										Edit video
									</button>
									<a className="btn" href={gen.durable?.mediaPath ?? gen.videoUrl} download>Download original</a>
									<p className="muted small">Opens the ReelForge Studio editor with this video in the media library and on the timeline. The original stays untouched.</p>
								</div>
							</div>
						)}
					</>
				)}
			</section>
		</div>
	)
}