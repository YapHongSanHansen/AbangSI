import type {ReactNode} from "react"

import {CreatePage} from "./pages/CreatePage"
import {StudioPage} from "./pages/StudioPage"
import {ProjectsPage} from "./pages/ProjectsPage"
import {AboutEditingPage} from "./pages/AboutEditingPage"
import {navigate, useLocation} from "./router"

function NavLink({to, children}: {to: string, children: ReactNode}) {
	const {path} = useLocation()
	const active = to === "/" ? path === "/" : path.startsWith(to)
	return (
		<a href={to} className={`nav-link${active ? " active" : ""}`} onClick={e => { e.preventDefault(); navigate(to) }}>
			{children}
		</a>
	)
}

export function App() {
	const {path, search} = useLocation()
	const studio = path.startsWith("/studio")
	return (
		<div className={`shell${studio ? " shell--studio" : ""}`}>
			<header className="topbar">
				<a href="/" className="brand" onClick={e => { e.preventDefault(); navigate("/") }}>Reel<b>Forge</b></a>
				<nav className="nav">
					<NavLink to="/">Create</NavLink>
					<NavLink to="/projects">Projects</NavLink>
					<NavLink to="/about-editing">Editing: what's supported</NavLink>
				</nav>
			</header>
			<main className="main">
				{studio ? <StudioPage search={search} key={search} />
					: path.startsWith("/projects") ? <ProjectsPage />
					: path.startsWith("/about-editing") ? <AboutEditingPage />
					: <CreatePage />}
			</main>
		</div>
	)
}