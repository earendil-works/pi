// Chord v2's client surfaces, the server side (`@earendil-works/chord/surfaces`; slice 11 §1, §4): the web surface
// (base bundle, plugin scripts, `WebScripts`, the page) and the terminal surface.

export { type BaseBundle, processConditions } from "./bundle.ts";
export type { ServedFile } from "./served.ts";
export { TUI_PREFIX, type TuiStart, type TuiSurface, type TuiSurfaceOptions, tuiSurface } from "./tui.ts";
export {
	type PageAssets,
	pageScripts,
	WEB_PREFIX,
	type WebSurface,
	type WebSurfaceOptions,
	webSurface,
} from "./web.ts";
