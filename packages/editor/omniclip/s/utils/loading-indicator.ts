// ReelForge: moved out of main.ts to break the main <-> context import cycle
// (es-module-shims cycle shells left this binding undefined once bridge.ts joined the graph).
export function removeLoadingPageIndicator() {
	const loadingPageIndicatorElement = document.querySelector(".loading-page-indicator")
	if(loadingPageIndicatorElement)
		loadingPageIndicatorElement.remove()
}