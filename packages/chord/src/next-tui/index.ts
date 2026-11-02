// Chord v2's terminal surface, the sandbox side (`@earendil-works/chord/next/tui` once v2 has its entry point; slice
// 11 §4): `startTerminalRuntime` in the app's terminal entry, the bridged terminal, the theme lookup and `TuiScope`.
// The launcher and the server side are `next/tui/launcher` and `next/web/server`'s `tuiSurface`.

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
