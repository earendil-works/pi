// Chord v2's terminal launcher (`@earendil-works/chord/tui/launcher`; slice 11 §4): the trusted Node side of a terminal
// client, running the app's terminal code in the sandbox.

export type { PromptTerminal } from "./actions.ts";
export type { TerminalCredentials } from "./credentials.ts";
export { filterOutput } from "./filter.ts";
export { type RunningTerminal, startTerminal, type TerminalOptions, terminalFile } from "./launcher.ts";
export { requireSandboxNode } from "./sandbox.ts";
