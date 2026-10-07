// ReelForge fork of Omniclip's entry point.
// Changes vs upstream (omni-media/omniclip v1.1.3, MIT):
//  - posthog analytics removed
//  - "/" redirects into the editor (project list) instead of the marketing landing page
//  - CapCut-style default layout (tools left, preview centre, inspector right, timeline bottom)
//  - ReelForge header + "generated video is one clip" notice
//  - ReelForge bridge (s/bridge.ts) for the Higgsfield -> editor handoff
import {register_to_dom, html, Nexus, generate_id} from "@benev/slate"
import {ConstructEditor, single_panel_layout} from "@benev/construct/x/mini.js"

import {startBridge} from "./bridge.js"
import {Tooltip} from './views/tooltip/view.js'
import {HashRouter} from './tools/hash-router.js'
import checkSvg from './icons/gravity-ui/check.svg.js'
import exportSvg from './icons/gravity-ui/export.svg.js'
import {ShortcutsManager} from './views/shortcuts/view.js'
import {TextPanel} from "./components/omni-text/panel.js"
import {AnimPanel} from "./components/omni-anim/panel.js"
import {MediaPanel} from "./components/omni-media/panel.js"
import {OmniText} from "./components/omni-text/component.js"
import {OmniAnim} from "./components/omni-anim/component.js"
import {OmniMedia} from "./components/omni-media/component.js"
import {FiltersPanel} from './components/omni-filters/panel.js'
import {TimelinePanel} from "./components/omni-timeline/panel.js"
import {OmniManager} from './components/omni-manager/component.js'
import {OmniFilters} from './components/omni-filters/component.js'
import {OmniTimeline} from "./components/omni-timeline/component.js"
import pencilSquareSvg from './icons/gravity-ui/pencil-square.svg.js'
import {ProjectSettingsPanel} from "./views/project-settings/panel.js"
import {TransitionsPanel} from "./components/omni-transitions/panel.js"
import {omnislate, OmniContext, collaboration} from "./context/context.js"
import {OmniTransitions} from "./components/omni-transitions/component.js"
import {ExportPanel} from "./components/omni-timeline/views/export/panel.js"
import {MediaPlayerPanel} from "./components/omni-timeline/views/media-player/panel.js"
import {ExportConfirmModal, ExportInProgressOverlay} from './components/omni-timeline/views/export/view.js'

const LAYOUT_VERSION = "reelforge-capcut-1"

// construct layout tree: a "cell" splits its children (vertical = stacked), a "pane" holds tabbed panels
function pane(panels: string[], size: number | null) {
	return {
		id: generate_id(),
		kind: "pane",
		size,
		active_leaf_index: 0,
		children: panels.map(panel => ({id: generate_id(), kind: "leaf", panel})),
	}
}

export const capcut_layout = () => ({
	id: generate_id(),
	kind: "cell",
	size: null,
	vertical: true,
	children: [
		{
			id: generate_id(),
			kind: "cell",
			size: 60,
			vertical: false,
			children: [
				pane(["MediaPanel", "TextPanel", "TransitionsPanel", "FiltersPanel", "AnimPanel"], 26),
				pane(["MediaPlayerPanel"], 50),
				pane(["ExportPanel", "ProjectSettingsPanel"], null),
			],
		},
		pane(["TimelinePanel"], null),
	],
}) as any

export function setupContext(projectId: string) {
	try {
		if (localStorage.getItem("reelforge_layout_version") !== LAYOUT_VERSION) {
			localStorage.removeItem("construct_layout")
			localStorage.setItem("reelforge_layout_version", LAYOUT_VERSION)
		}
	} catch {}
	omnislate.context = new OmniContext({
		projectId,
		panels: {
			TimelinePanel,
			MediaPanel,
			MediaPlayerPanel,
			TextPanel,
			ExportPanel,
			ProjectSettingsPanel,
			AnimPanel,
			FiltersPanel,
			TransitionsPanel
		},
		layouts: {
			empty: single_panel_layout("TimelinePanel"),
			default: capcut_layout,
		},
	})
	return omnislate
}

register_to_dom({OmniManager})
let registered = false

export function removeLoadingPageIndicator() {
	const loadingPageIndicatorElement = document.querySelector(".loading-page-indicator")
	if(loadingPageIndicatorElement)
		document.body.removeChild(loadingPageIndicatorElement!)
}

const VideoEditor =  (omnislate: Nexus<OmniContext>) => omnislate.light_view((use) => () => {
	use.watch(() => use.context.state)
	const collaboration = use.context.controllers.collaboration
	const [renameDisabled, setRenameDisabled] = use.state(true)
	const toggleProjectRename = (e: PointerEvent) => {
		e.preventDefault()
		setRenameDisabled(!renameDisabled)
	}

	const confirmProjectRename = () => {
		const projectName = use.element.querySelector(".input-name") as HTMLInputElement
		use.context.actions.set_project_name(projectName.value)
	}

	use.mount(() => {
		const dispose = collaboration.onChange(() => use.rerender())
		return () => dispose()
	})

	const [showConfirmExportModal, setShowConfirmExportModal] = use.state(false)
	const isClient = collaboration.client

	return html`
		<div class=editor>
			${ExportConfirmModal([showConfirmExportModal, setShowConfirmExportModal])}
			${ExportInProgressOverlay([])}
			<div class=editor-header>
				<div class=flex>
					<span class="rf-logo" title="ReelForge editor (powered by Omniclip)">Reel<b>Forge</b></span>
					<div class="project-name">
						<span class="box">
							<input class="input-name" ?disabled=${renameDisabled} .value=${use.context.state.projectName}>
							<span class="icons" @click=${toggleProjectRename}>
								${renameDisabled ? html`${pencilSquareSvg}` : html`<span @click=${confirmProjectRename} class="check">${checkSvg}</span>`}
							</span>
						</span>
					</div>
					<span class="rf-chip" title="The generated MP4 is imported as one video clip. Text, captions or music that the model baked into the video are part of the pixels/audio track and cannot be edited as separate layers. Add new text/audio on top instead.">
						Generated video = 1 clip &middot; baked-in text/music not editable
					</span>
				</div>
				<div class="export">
					${ShortcutsManager([])}
					${Tooltip(
						html`
						<button
							?disabled=${use.context.state.settings.bitrate <= 0 || isClient}
							class="export-button"
							@click=${() => setShowConfirmExportModal(true)}
						>
							<span class="text">${exportSvg}<span>Export MP4</span></span>
						</button>`,
						html`${isClient ?  "Only host can export" : null}`,
						"",
						"bottom-end"
					)}
				</div>
			</div>
			<construct-editor></construct-editor>
		</div>
	`
})

const router = new HashRouter({
	'/': () => {
		// ReelForge: no marketing landing page inside the product, go to the project list
		setTimeout(() => { location.hash = "#/editor" })
		return html``
	},
	'/editor': () => {
		collaboration.disconnect()
		return html`<omni-manager></omni-manager>`
	},
	'/editor/*': (projectId) => {
		if(!collaboration.initiatingProject) {
			collaboration.disconnect()
		}
		if(!registered) {
			register_to_dom({OmniTimeline, OmniText, OmniMedia, ConstructEditor, OmniFilters, OmniTransitions, OmniAnim})
			registered = true
		}
		const omnislate = setupContext(projectId)
		return html`${VideoEditor(omnislate)()}`
	},
})

document.body.append(router.element)
document.documentElement.className = "sl-theme-dark"
startBridge()