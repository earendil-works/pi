/**
 * Project Trust Extension
 *
 * Demonstrates the project_trust event. Install globally or pass via -e:
 *
 *   mkdir -p ~/.pi/agent/extensions
 *   cp packages/coding-agent/examples/extensions/project-trust.ts ~/.pi/agent/extensions/
 *
 * Or:
 *
 *   pi -e packages/coding-agent/examples/extensions/project-trust.ts
 *
 * Try it in a project containing .pi, AGENTS.md/CLAUDE.md, or .agents/skills.
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let loadCount = 0;
	loadCount++;

	// Multiple handlers in one extension are allowed. The first handler that returns
	// { trusted: "yes" } or { trusted: "no" } wins and suppresses the built-in
	// trust prompt. Return { trusted: "undecided" } to let another handler or the
	// built-in flow decide.
	pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
		ctx.ui.notify(`project_trust fired for ${event.cwd} (mode: ${ctx.mode}, load: ${loadCount})`, "info");

		if (!ctx.hasUI) {
			return { trusted: "undecided" };
		}

		const choice = await ctx.ui.select(`Project trust for:\n${event.cwd}`, [
			"Trust and remember",
			"Trust with note and remember",
			"Trust this session",
			"Do not trust this session",
			"Let built-in prompt decide",
		]);

		if (choice === "Trust with note and remember") {
			const note = await ctx.ui.input("Project trust note", "Optional note for this demo");
			ctx.ui.notify(note ? `Recorded demo note: ${note}` : "No demo note entered", "info");
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust and remember") {
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust this session") {
			return { trusted: "yes" };
		}
		if (choice === "Do not trust this session") {
			return { trusted: "no" };
		}
		if (choice === "Let built-in prompt decide") {
			return { trusted: "undecided" };
		}
		return { trusted: "undecided" };
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(`project-trust example loaded after trust resolution in ${ctx.cwd}`, "info");
	});
}
