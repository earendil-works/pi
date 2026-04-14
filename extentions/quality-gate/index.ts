/**
 * Quality Gate Extension
 *
 * Manual-only quality pipeline via /quality command.
 * Auto-trigger removed — pre-commit-gate handles that on /new.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const QUALITY_GATE_MARKER = "[quality-gate]";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("quality", {
		description: "Manually trigger the quality gate pipeline (sentinel + reviewer + tester + frontend)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for it to finish.", "warning");
				return;
			}
			pi.sendUserMessage(`${QUALITY_GATE_MARKER} Run the quality gate now:

1. Review changed code for sloppy patterns — unused imports, dead code, inconsistent naming, duplication. Fix issues directly.

2. Use the subagent tool in parallel mode to run:
   - sentinel agent with mode "diff" — security audit on uncommitted changes
   - reviewer agent with mode "tdd" — check TDD compliance
   - tester agent with depth "targeted" — run tests covering changed files, fix failures

Report results. List any blocking issues clearly.`);
		},
	});
}
