import type { AgentState } from "@kennyfrc/mu-agent-core";
import { theme } from "../theme/theme.js";
import { formatModelStatusLabel } from "./footer.js";

export function formatComposerStatusLabel(state: AgentState, bashMode: boolean): string {
	const label = formatModelStatusLabel(state);
	if (!bashMode) {
		return label;
	}

	return `${label} ${theme.fg("warning", "• BASH")}`;
}
