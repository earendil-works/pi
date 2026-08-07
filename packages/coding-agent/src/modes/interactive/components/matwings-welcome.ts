// MatwingsVenus welcome panel — a kimi-code-style rounded box with a logo,
// wordmark, and Directory/Session/Model/Version info rows. Rendered into the
// interactive header. Pure render function (no state); the caller passes live
// values, so it reflects the current session/model/auth on each re-render.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DISPLAY_VERSION, PRODUCT_NAME } from "../../../core/branding.ts";
import { theme } from "../theme/theme.ts";

export interface MatwingsWelcomeState {
	workDir: string;
	sessionId: string;
	/** Active model id (e.g. "anthropic/claude-..."), or "" when none is set. */
	modelLabel: string;
	/** Whether the MatwingsVenus platform session is authenticated. */
	authed: boolean;
}

/** Render the welcome box as a single multi-line string for the given width. */
export function renderMatwingsWelcome(state: MatwingsWelcomeState, width: number): string {
	const safeWidth = Math.max(24, width);
	const accent = (s: string): string => theme.fg("accent", s);
	const dim = (s: string): string => theme.fg("dim", s);
	const warning = (s: string): string => theme.fg("warning", s);
	const bold = (s: string): string => theme.bold(s);

	const innerWidth = Math.max(1, safeWidth - 4);
	const pad = "  ";

	// Brand on a single line, subtext below.
	const headerLines = [
		accent(bold(PRODUCT_NAME)),
		state.authed ? dim("The SAION AI Scientist is ready.") : warning("Not logged in — type /login to authenticate."),
	];

	const label = (s: string): string => dim(bold(s));
	const modelValue = state.modelLabel.trim()
		? state.modelLabel
		: warning("not set — type /model or set ANTHROPIC_API_KEY");
	const infoLines = [
		`${label("Directory: ")}${state.workDir}`,
		`${label("Session:   ")}${state.sessionId || "—"}`,
		`${label("Model:     ")}${modelValue}`,
		`${label("Version:   ")}${DISPLAY_VERSION}`,
	];

	const contentLines = [...headerLines, "", ...infoLines];

	const lines: string[] = [
		"",
		accent(`╭${"─".repeat(safeWidth - 2)}╮`),
		`${accent("│")}${" ".repeat(safeWidth - 2)}${accent("│")}`,
	];
	for (const content of contentLines) {
		const truncated = truncateToWidth(content, innerWidth, "…");
		const rightPad = Math.max(0, innerWidth - visibleWidth(truncated));
		lines.push(`${accent("│")}${pad}${truncated}${" ".repeat(rightPad)}${accent("│")}`);
	}
	lines.push(`${accent("│")}${" ".repeat(safeWidth - 2)}${accent("│")}`);
	lines.push(accent(`╰${"─".repeat(safeWidth - 2)}╯`));
	lines.push("");

	return lines.map((line) => truncateToWidth(line, safeWidth, "…")).join("\n");
}
