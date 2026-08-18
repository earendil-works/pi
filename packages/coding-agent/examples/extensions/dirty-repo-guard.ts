/**
 * Dirty Repo Guard Extension
 *
 * Prevents session changes when there are uncommitted git changes.
 * Useful to ensure work is committed before switching context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
	// Check for uncommitted changes
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

	if (code !== 0) {
		// Not a git repo, allow the action
		return;
	}

	const hasChanges = stdout.trim().length > 0;
	if (!hasChanges) {
		return;
	}

	if (!ctx.hasUI) {
		// In non-interactive mode, block by default
		return { cancel: true };
	}

	// Count changed files
	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;

	const choice = await ctx.ui.select(`You have ${changedFiles} uncommitted file(s). ${action} anyway?`, [
		"Yes, proceed anyway",
		"No, let me commit first",
	]);

	if (choice !== "Yes, proceed anyway") {
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";
		return checkDirtyRepo(pi, ctx, action);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		return checkDirtyRepo(pi, ctx, "fork");
	});
}
