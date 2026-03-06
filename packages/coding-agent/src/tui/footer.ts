import type { AgentState } from "@kennyfrc/mu-agent-core";
import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { supportsXhigh } from "@kennyfrc/mu-ai";
import { type Component, visibleWidth } from "@kennyfrc/mu-tui";
import { existsSync, type FSWatcher, readFileSync, watch } from "fs";
import { dirname, join } from "path";
import { supportsFastMode } from "../fast-mode.js";
import { isModelUsingOAuth } from "../model-config.js";
import { getActiveOAuthAccount, listOAuthAccounts } from "../oauth/index.js";
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
	private title: string | null = null;

	constructor(state: AgentState) {
		this.state = state;
	}

	/**
	 * Set the conversation title to display in the footer.
	 */
	setTitle(title: string | null): void {
		this.title = title;
	}

	/**
	 * Get the current conversation title.
	 */
	getTitle(): string | null {
		return this.title;
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

		// Show cost with (sub) or (api) indicator
		const usingSubscription = this.state.model ? isModelUsingOAuth(this.state.model) : false;
		let subscriptionSuffix: string | null = null;
		if (usingSubscription && this.state.model?.provider === "openai-codex") {
			const accounts = listOAuthAccounts("openai-codex");
			if (accounts.length > 1) {
				const activeAccount = getActiveOAuthAccount("openai-codex");
				if (activeAccount) {
					const label = activeAccount.label ?? activeAccount.credentials.email ?? activeAccount.id;
					const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(label);
					const displayLabel = isUuid ? `••••${label.slice(-4)}` : label;
					const truncated = displayLabel.length > 12 ? `${displayLabel.slice(0, 12)}…` : displayLabel;
					subscriptionSuffix = `${truncated}/${accounts.length}`;
				}
			}
		}
		if (totalCost || usingSubscription || this.state.model) {
			const type = usingSubscription ? (subscriptionSuffix ? ` (sub:${subscriptionSuffix})` : " (sub)") : " (api)";
			const costStr = `$${totalCost.toFixed(3)}${type}`;
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
			// Healthy - use regular text color
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		const statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = this.state.model?.id || "no-model";
		const providerName = this.state.model?.provider;

		// Add thinking level hint if model supports reasoning and thinking is enabled
		let rightSide = modelName;
		if (this.state.model?.reasoning) {
			const thinkingLevel = this.state.thinkingLevel || "off";
			const canShowXhigh = this.state.model ? supportsXhigh(this.state.model) : false;
			if (thinkingLevel !== "off" && (thinkingLevel !== "xhigh" || canShowXhigh)) {
				rightSide = `${modelName} • ${thinkingLevel}`;
			}
		}

		if (supportsFastMode(this.state.model)) {
			rightSide = `${rightSide} • fast:${this.state.fastMode ? "on" : "off"}`;
		}

		// Append provider to reduce billing/provider ambiguity (e.g., OpenAI vs OpenRouter vs OpenAI Codex)
		if (providerName) {
			rightSide = `${rightSide} [${providerName}]`;
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

		// Build first line: pwd on left, title on right (if available)
		let firstLine: string;

		if (this.showExitHint) {
			firstLine = theme.fg("text", "Press Ctrl+C again to exit");
		} else {
			const pwdStr = theme.fg("dim", pwd);
			const pwdWidth = visibleWidth(pwdStr);

			if (this.title) {
				// Show pwd on left, title on right
				const titleStr = theme.fg("dim", this.title);
				const titleWidth = visibleWidth(titleStr);
				const minGap = 2;
				const totalNeeded = pwdWidth + minGap + titleWidth;

				if (totalNeeded <= width) {
					// Both fit - add padding to right-align title
					const padding = " ".repeat(width - pwdWidth - titleWidth);
					firstLine = pwdStr + padding + titleStr;
				} else {
					// Not enough space - truncate title
					const availableForTitle = width - pwdWidth - minGap;
					if (availableForTitle > 10) {
						const truncatedTitle = this.title.substring(0, availableForTitle - 3) + "...";
						const truncatedTitleStr = theme.fg("dim", truncatedTitle);
						const padding = " ".repeat(width - pwdWidth - visibleWidth(truncatedTitleStr));
						firstLine = pwdStr + padding + truncatedTitleStr;
					} else {
						// No space for title, just show pwd
						firstLine = pwdStr;
					}
				}
			} else {
				// No title, just show pwd
				firstLine = pwdStr;
			}
		}

		return [firstLine, theme.fg("dim", statsLine)];
	}
}
