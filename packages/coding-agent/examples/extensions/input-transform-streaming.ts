/**
 * Streaming-Aware Input Gate
 *
 * Demonstrates `event.streamingBehavior` to skip expensive pre-processing
 * during mid-stream steering, where low latency matters.
 *
 * This extension prepends `git diff --stat` output when the user mentions
 * file changes, giving the model immediate context. During steering the
 * exec call is skipped so the correction reaches the model without delay.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/input-transform-streaming.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRIGGER = /\b(changes?|diff|modified)\b/i;

export default function (pi: ExtensionAPI) {
	let isGitRepo: boolean | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: ctx.cwd, timeout: 3_000 });
		isGitRepo = code === 0;
	});

	pi.on("input", async (event) => {
		// During steering, skip the exec call — corrections should be fast
		if (event.streamingBehavior === "steer") {
			return { action: "continue" };
		}

		if (!TRIGGER.test(event.text)) {
			return { action: "continue" };
		}

		// Skip git commands if not in a git repository
		if (isGitRepo !== true) {
			return { action: "continue" };
		}

		const { stdout, code } = await pi.exec("git", ["diff", "--stat"]);
		if (code !== 0 || !stdout.trim()) {
			return { action: "continue" };
		}

		return {
			action: "transform",
			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,
		};
	});
}
