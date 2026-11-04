// Chord v2's terminal surface, the sandbox side (`@earendil-works/chord/tui`; slice 11 §4): `startTerminalRuntime` in
// the app's terminal entry, the bridged terminal, the theme lookup and `TuiScope`. The launcher and the server side are
// `/tui/launcher` and `/surfaces`'s `tuiSurface`.

export type { PageState } from "../surfaces/page-state.ts";
export type { Bridge, BridgeRequest, BridgeStart, LauncherMessage, SandboxMessage } from "./bridge.ts";
export {
	type AttachedFile,
	startTerminalRuntime,
	type TerminalRuntime,
	type TerminalRuntimeOptions,
} from "./runtime.ts";
export { TuiScope } from "./scope.ts";
export { BridgeTerminal } from "./terminal.ts";
export { TerminalTheme } from "./theme.ts";
