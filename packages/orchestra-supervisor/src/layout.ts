// Watch layout: cells-based perTab, iTerm2 AppleScript + tmux fallback.
// Built with splits only: first columns, then rows within each column.
export interface LayoutOptions {
	cols: number;
	rows: number;
	agentCount: number;
	minCols?: number;
	minRows?: number;
	maxPerTab?: number;
}

export function perTabCount(opts: LayoutOptions): {
	perTab: number;
	tabs: number;
	colsNeeded: number;
	rowsNeeded: number;
} {
	const minCols = opts.minCols ?? 80;
	const minRows = opts.minRows ?? 22;
	const maxPerTab = opts.maxPerTab ?? 8;
	const colSlots = Math.max(1, Math.floor(opts.cols / minCols));
	const rowSlots = Math.max(1, Math.floor(opts.rows / minRows));
	let perTab = colSlots * rowSlots;
	// Fit to agent count, clamped to [2, maxPerTab].
	perTab = Math.min(Math.max(2, perTab), maxPerTab, Math.max(2, opts.agentCount));
	// Clamp tiny windows to 2 (never below 2 panes even if grid math says 1).
	if (perTab < 2) perTab = 2;
	const tabs = Math.max(1, Math.ceil(opts.agentCount / perTab));
	// Layout within tab: columns = ceil(sqrt(perTab)) grid-ish; columns first then rows.
	const colsNeeded = Math.ceil(Math.sqrt(perTab));
	const rowsNeeded = Math.ceil(perTab / colsNeeded);
	return { perTab, tabs, colsNeeded, rowsNeeded };
}

export function buildITerm2Script(
	agentIds: string[],
	opts: { cols: number; rows: number; minCols?: number; minRows?: number; maxPerTab?: number },
): string {
	// NOTE: native split opcodes are create tab / split vertically / split horizontally (no synthesized keystrokes).
	const { perTab, tabs, colsNeeded } = perTabCount({
		cols: opts.cols,
		rows: opts.rows,
		agentCount: agentIds.length,
		minCols: opts.minCols,
		minRows: opts.minRows,
		maxPerTab: opts.maxPerTab,
	});
	const lines: string[] = [];
	lines.push(`-- Orchestra watch layout: ${agentIds.length} agents, ${perTab} per tab, ${tabs} tab(s)`);
	lines.push('tell application "iTerm2"');
	lines.push("  activate");
	lines.push("  set w to current window");
	let tabIdx = 0;
	for (let t = 0; t < tabs; t++) {
		if (t > 0) lines.push("  create tab with default profile");
		const slice = agentIds.slice(t * perTab, (t + 1) * perTab);
		// First pane: supervisor view (agentIds[0] is supervisor placeholder? caller passes ["supervisor", ...agentIds]).
		let paneIdx = 0;
		for (const agentId of slice) {
			if (paneIdx === 0 && t === 0) {
				// Tab already has one session: use it.
				lines.push(
					`  write text "orchestra watch ${agentId}" to the current session of ${t === 0 ? "w" : "w"} of current window`,
				);
			} else {
				// Alternate splits to form columns first, then rows.
				if (paneIdx % colsNeeded === 0) {
					lines.push("  tell w to split vertically with same profile");
				} else {
					lines.push("  tell w to split horizontally with same profile");
				}
				lines.push(`  write text "orchestra watch ${agentId}" to the current session of w of current window`);
			}
			paneIdx++;
		}
		tabIdx++;
	}
	lines.push("end tell");
	return lines.join("\n");
}

export function buildTmuxScript(agentIds: string[]): string {
	const lines: string[] = ["tmux new-session -d -s orchestra"];
	agentIds.forEach((id, i) => {
		if (i === 0) lines.push(`tmux send-keys -t orchestra "orchestra watch ${id}" C-m`);
		else lines.push(`tmux split-window -t orchestra "orchestra watch ${id}"`);
	});
	lines.push("tmux attach -t orchestra");
	return lines.join("\n");
}

export function detectTerminal(): { kind: "iterm2" | "tmux" | "unknown"; termProgram: string } {
	const term = process.env.TERM_PROGRAM ?? "";
	if (term.toLowerCase().includes("iterm")) return { kind: "iterm2", termProgram: term };
	if (term === "tmux") return { kind: "tmux", termProgram: term };
	return { kind: "unknown", termProgram: term };
}
