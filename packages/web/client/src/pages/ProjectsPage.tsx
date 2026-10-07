import {useEffect, useState} from "react"

import {api} from "../api"
import {navigate} from "../router"

export function ProjectsPage() {
	const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>["projects"] | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => { api.listProjects().then(r => setProjects(r.projects)).catch(e => setError(String(e.message ?? e))) }, [])
	return (
		<div className="page">
			<section className="card">
				<h1>Saved projects</h1>
				<p className="muted">Projects saved from ReelForge Studio. Reopening restores the edit and re-downloads its media from the server (works in a fresh browser too).</p>
				{error && <div className="alert error">{error}</div>}
				{projects?.length === 0 && <div className="placeholder">No saved projects yet.</div>}
				<ul className="project-list">
					{projects?.map(p => (
						<li key={p.projectId}>
							<div>
								<strong>{p.name ?? p.projectId}</strong>
								<div className="muted small">{new Date(p.updatedAt).toLocaleString()} &middot; {p.media} media file(s)</div>
							</div>
							<button className="btn" onClick={() => navigate(`/studio?project=${encodeURIComponent(p.projectId)}`)}>Open</button>
						</li>
					))}
				</ul>
			</section>
		</div>
	)
}