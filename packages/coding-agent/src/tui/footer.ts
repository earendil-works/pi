import type { AgentState } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { type Component, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, type FSWatcher, readFileSync, watch } from "fs";
import { dirname, join } from "path";
import { isModelUsingOAuth } from "../model-config.js";
import { theme } from "../theme/theme.js";

/**
 * Find the git root directory by walking up from cwd.
 * Returns the path to .git/HEAD if found, null otherwise.
 */
function findGitHeadPath(): string | null {
	let dir = process.cwd();
	while (true) {
		const gitHeadPath = join(dir, ".git", "HEAD");
		if (existsSync(gitHeadPath)) {
			return gitHeadPath;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			// Reached filesystem root
			return null;
		}
		dir = parent;
	}
}

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	private state: AgentState;
	private cachedBranch: string | null | undefined = undefined; // undefined = not checked yet, null = not in git repo, string = branch name
	private showExitHint = false;
	private gitWatcher: FSWatcher | null = null;
	private onBranchChange: (() => void) | null = null;

	constructor(state: AgentState) {
		this.state = state;
	}

	/**
	 * Set up a file watcher on .git/HEAD to detect branch changes.
	 * Call the provided callback when branch changes.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		// Clean up existing watcher
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = findGitHeadPath();
		if (!gitHeadPath) {
			return;
		}

		try {
			this.gitWatcher = watch(gitHeadPath, () => {
				this.cachedBranch = undefined; // Invalidate cache
				if (this.onBranchChange) {
					this.onBranchChange();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
	}

	updateState(state: AgentState): void {
		this.state = state;
	}

	/**
	 * Set whether to show the "Press Ctrl+C again to exit" hint in place of the pwd line.
	 */
	setShowExitHint(show: boolean): void {
		this.showExitHint = show;
	}

	invalidate(): void {
		// Invalidate cached branch so it gets re-read on next render
		this.cachedBranch = undefined;
	}

	/**
	 * Get current git branch by reading .git/HEAD directly.
	 * Returns null if not in a git repo, branch name otherwise.
	 */
	private getCurrentBranch(): string | null {
		// Return cached value if available
		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		try {
			const gitHeadPath = findGitHeadPath();
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return this.cachedBranch;
			}
			const content = readFileSync(gitHeadPath, "utf8").trim();

			if (content.startsWith("ref: refs/heads/")) {
				// Normal branch: extract branch name
				this.cachedBranch = content.slice(16);
			} else {
				// Detached HEAD state
				this.cachedBranch = "detached";
			}
		} catch {
			// Not in a git repo or error reading file
			this.cachedBranch = null;
		}

		return this.cachedBranch;
	}

	render(width: number): string[] {
		// Calculate cumulative usage from all assistant messages
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of this.state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		// Get last assistant message for context percentage calculation (skip aborted messages)
		const lastAssistantMessage = this.state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		// Calculate context percentage from last message (input + output + cacheRead + cacheWrite)
		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = this.state.model?.contextWindow || 0;
		const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
		const contextPercent = contextPercentValue.toFixed(1);

		// Format token counts (similar to web-ui)
		const formatTokens = (count: number): string => {
			if (count < 1000) return count.toString();
			if (count < 10000) return (count / 1000).toFixed(1) + "k";
			return Math.round(count / 1000) + "k";
		};

		// Replace home directory with ~
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = "~" + pwd.slice(home.length);
		}

		// Add git branch if available
		const branch = this.getCurrentBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Truncate path if too long to fit width
		const maxPathLength = Math.max(20, width - 10); // Leave some margin
		if (pwd.length > maxPathLength) {
			const start = pwd.slice(0, Math.floor(maxPathLength / 2) - 2);
			const end = pwd.slice(-(Math.floor(maxPathLength / 2) - 1));
			pwd = `${start}...${end}`;
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = this.state.model ? isModelUsingOAuth(this.state.model) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage with handoff hints
		let contextPercentStr: string;
		const contextPercentDisplay = `${contextPercent}% of ${formatTokens(contextWindow)}`;
		if (contextPercentValue >= 90) {
			// Critical - strongly suggest handoff
			contextPercentStr = theme.fg("budgetRed", `${contextPercentDisplay} (handoff soon)`);
		} else if (contextPercentValue >= 80) {
			// High - mention handoff
			contextPercentStr = theme.fg("budgetOrange", `${contextPercentDisplay} (consider handoff)`);
		} else if (contextPercentValue >= 60) {
			// Moderate - just show percentage
			contextPercentStr = theme.fg("budgetYellow", contextPercentDisplay);
		} else {
			// Healthy
			contextPercentStr = theme.fg("budgetGreen", contextPercentDisplay);
		}
		statsParts.push(contextPercentStr);

		const statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = this.state.model?.id || "no-model";

		// Add thinking level hint if model supports reasoning and thinking is enabled
		let rightSide = modelName;
		if (this.state.model?.reasoning) {
			const thinkingLevel = this.state.thinkingLevel || "off";
			if (thinkingLevel !== "off") {
				rightSide = `${modelName} • ${thinkingLevel}`;
			}
		}

		const statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 3) {
				// Truncate to fit (strip ANSI codes for length calculation, then truncate raw string)
				const plainRightSide = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
				const truncatedPlain = plainRightSide.substring(0, availableForRight);
				// For simplicity, just use plain truncated version (loses color, but fits)
				const padding = " ".repeat(width - statsLeftWidth - truncatedPlain.length);
				statsLine = statsLeft + padding + truncatedPlain;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Return two lines: pwd (or exit hint) and stats
		const firstLine = this.showExitHint ? theme.fg("text", "Press Ctrl+C again to exit") : theme.fg("dim", pwd);
		return [firstLine, theme.fg("dim", statsLine)];
	}
}
