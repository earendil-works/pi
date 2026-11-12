// Writes runtime diagnostics to stderr for the CLI and the non-interactive modes.
import chalk from "chalk";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";

/** Print each diagnostic to stderr as `Error: ...` (red), `Warning: ...` (yellow) or a dim info line. */
export function writeDiagnosticsToStderr(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}
