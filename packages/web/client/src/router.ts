import {useEffect, useState} from "react"

export function navigate(to: string) {
	history.pushState(null, "", to)
	window.dispatchEvent(new PopStateEvent("popstate"))
}

export function useLocation() {
	const [loc, setLoc] = useState(() => ({path: location.pathname, search: location.search}))
	useEffect(() => {
		const on = () => setLoc({path: location.pathname, search: location.search})
		window.addEventListener("popstate", on)
		return () => window.removeEventListener("popstate", on)
	}, [])
	return loc
}