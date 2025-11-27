import type { AgentState } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { type Component, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "fs";
import { join } from "path";
import { theme } from "../theme/theme.js";

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	private state: AgentState;
	private cachedBranch: string | null | undefined = undefined; // undefined = not checked yet, null = not in git repo, string = branch name

	constructor(state: AgentState) {
		this.state = state;
	}

	updateState(state: AgentState): void {
		this.state = state;
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
			const gitHeadPath = join(process.cwd(), ".git", "HEAD");
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
		if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", `${contextPercent}%`);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", `${contextPercent}%`);
		} else {
			contextPercentStr = `${contextPercent}%`;
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

		// Return two lines: pwd and stats
		return [theme.fg("dim", pwd), theme.fg("dim", statsLine)];
	}
}
