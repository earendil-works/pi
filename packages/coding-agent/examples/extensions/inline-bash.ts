/**
 * Inline Bash Extension - expands inline bash commands in user prompts.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/inline-bash.ts
 *
 * Then type prompts with inline bash:
 *   What's in !{pwd}?
 *   The current branch is !{git branch --show-current} and status: !{git status --short}
 *   My node version is !{node --version}
 *
 * The !{command} patterns are executed and replaced with their output before
 * the prompt is sent to the agent.
 *
 * Note: Regular !command syntax (whole-line bash) is preserved and works as before.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const PATTERN = /!\{([^}]+)\}/g;
	const TIMEOUT_MS = 30000;

	pi.on("input", async (event, ctx) => {
		const text = event.text;

		// Don't process if it's a whole-line bash command (starts with !)
		// This preserves the existing !command behavior
		if (text.trimStart().startsWith("!") && !text.trimStart().startsWith("!{")) {
			return { action: "continue" };
		}

		// Check if there are any inline bash patterns
		if (!PATTERN.test(text)) {
			return { action: "continue" };
		}

		// Reset regex state after test()
		PATTERN.lastIndex = 0;

		let result = text;
		const expansions: Array<{ command: string; output: string; error?: string }> = [];

		// Find all matches first (to avoid issues with replacing while iterating)
		const matches: Array<{ full: string; command: string }> = [];
		let match = PATTERN.exec(text);
		while (match) {
			matches.push({ full: match[0], command: match[1] });
			match = PATTERN.exec(text);
		}

		// Execute each command and collect results
		for (const { full, command } of matches) {
			try {
				const bashResult = await pi.exec("bash", ["-c", command], {
					timeout: TIMEOUT_MS,
				});

				const output = bashResult.stdout || bashResult.stderr || "";
				const trimmed = output.trim();

				if (bashResult.code !== 0 && bashResult.stderr) {
					expansions.push({
						command,
						output: trimmed,
						error: `exit code ${bashResult.code}`,
					});
				} else {
					expansions.push({ command, output: trimmed });
				}

				result = result.replace(full, trimmed);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				expansions.push({ command, output: "", error: errorMsg });
				result = result.replace(full, `[error: ${errorMsg}]`);
			}
		}

		// Show what was expanded (if UI available)
		if (ctx.hasUI && expansions.length > 0) {
			const summary = expansions
				.map((e) => {
					const status = e.error ? ` (${e.error})` : "";
					const preview = e.output.length > 50 ? `${e.output.slice(0, 50)}...` : e.output;
					return `!{${e.command}}${status} -> "${preview}"`;
				})
				.join("\n");

			ctx.ui.notify(`Expanded ${expansions.length} inline command(s):\n${summary}`, "info");
		}

		return { action: "transform", text: result, images: event.images };
	});
}
