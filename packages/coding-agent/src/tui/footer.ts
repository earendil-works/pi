import type { AgentState } from "@kennyfrc/mu-agent-core";
import { supportsXhigh } from "@kennyfrc/mu-ai";
import { type Component, visibleWidth } from "@kennyfrc/mu-tui";
import { existsSync, type FSWatcher, readFileSync, watch } from "fs";
import { dirname, join } from "path";
import { supportsFastMode } from "../fast-mode.js";
import { theme } from "../theme/theme.js";

interface FooterTransientStatus {
	indicator: string;
	message: string;
}

interface WorkingFooterLines {
	primary: string;
	secondary: string;
}

const segmenter = new Intl.Segmenter();

function truncatePlainTextEnd(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 1) return "…";

	const ellipsis = "…";
	const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
	const parts = Array.from(segmenter.segment(text), (part) => part.segment);

	let result = "";
	let resultWidth = 0;
	for (const part of parts) {
		const partWidth = visibleWidth(part);
		if (resultWidth + partWidth > targetWidth) break;
		result += part;
		resultWidth += partWidth;
	}

	return result + ellipsis;
}

function truncatePlainTextMiddle(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 1) return "…";

	const parts = Array.from(segmenter.segment(text), (part) => part.segment);
	const ellipsis = "…";
	const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));

	let left = "";
	let leftWidth = 0;
	let leftIndex = 0;
	while (leftIndex < parts.length) {
		const next = parts[leftIndex] ?? "";
		const nextWidth = visibleWidth(next);
		if (leftWidth + nextWidth > Math.ceil(targetWidth / 2)) break;
		left += next;
		leftWidth += nextWidth;
		leftIndex++;
	}

	let right = "";
	let rightWidth = 0;
	let rightIndex = parts.length - 1;
	while (rightIndex >= leftIndex) {
		const next = parts[rightIndex] ?? "";
		const nextWidth = visibleWidth(next);
		if (leftWidth + rightWidth + nextWidth > targetWidth) break;
		right = next + right;
		rightWidth += nextWidth;
		rightIndex--;
	}

	return left + ellipsis + right;
}

function renderSplitLine(options: {
	width: number;
	leftText: string;
	rightText: string;
	leftStyle: (text: string) => string;
	rightStyle: (text: string) => string;
	leftTruncation?: "end" | "middle";
	minimumLeftWidth?: number;
}): string {
	const { width, leftText, rightText, leftStyle, rightStyle, leftTruncation = "end", minimumLeftWidth = 8 } = options;

	if (width <= 0) {
		return "";
	}

	if (!leftText && !rightText) {
		return "";
	}

	if (!rightText) {
		const fittedLeft =
			leftTruncation === "middle" ? truncatePlainTextMiddle(leftText, width) : truncatePlainTextEnd(leftText, width);
		return leftStyle(fittedLeft);
	}

	if (!leftText) {
		const fittedRight = truncatePlainTextEnd(rightText, width);
		const gap = Math.max(0, width - visibleWidth(fittedRight));
		return " ".repeat(gap) + rightStyle(fittedRight);
	}

	const minGap = 2;
	const rightBudget = Math.max(1, width - minimumLeftWidth - minGap);
	const fittedRight = truncatePlainTextEnd(rightText, rightBudget);
	const fittedRightWidth = visibleWidth(fittedRight);
	const leftBudget = Math.max(1, width - fittedRightWidth - minGap);
	const fittedLeft =
		leftTruncation === "middle"
			? truncatePlainTextMiddle(leftText, leftBudget)
			: truncatePlainTextEnd(leftText, leftBudget);
	const fittedLeftWidth = visibleWidth(fittedLeft);
	const gap = Math.max(minGap, width - fittedLeftWidth - fittedRightWidth);

	return leftStyle(fittedLeft) + " ".repeat(gap) + rightStyle(fittedRight);
}

function styleWorkingIndicator(indicator: string, color: string): string {
	return Array.from(indicator)
		.map((char) => {
			if (char.trim().length === 0) {
				return char;
			}
			switch (char) {
				case "█":
					return `\x1b[1m${color}${char}\x1b[22m\x1b[39m`;
				case "▓":
					return `${color}${char}\x1b[39m`;
				case "▒":
					return `\x1b[2m${color}${char}\x1b[22m\x1b[39m`;
				case "░":
					return `\x1b[2m${color}${char}\x1b[22m\x1b[39m`;
				default:
					return `${color}${char}\x1b[39m`;
			}
		})
		.join("");
}

function splitWorkingFooterMessage(message: string): WorkingFooterLines {
	const match = /^Working \((.+)\)$/.exec(message);
	if (!match) {
		return {
			primary: message,
			secondary: "",
		};
	}

	const segments = match[1].split(" • ");
	const elapsed = segments.shift();
	if (!elapsed) {
		return {
			primary: message,
			secondary: "",
		};
	}

	return {
		primary: `Working • ${elapsed}`,
		secondary: segments.join(" • "),
	};
}

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
	private showModelStatus = true;
	private transientStatus: FooterTransientStatus | null = null;

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

	setUsageFooterMode(_mode: string): void {}

	setShowModelStatus(show: boolean): void {
		this.showModelStatus = show;
	}

	setUsageLimits(_snapshot: unknown): void {}

	setContextUsage(_contextTokens: number, _contextWindow: number): void {}

	setTransientStatus(status: FooterTransientStatus | null): void {
		this.transientStatus = status;
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

		pwd = truncatePlainTextMiddle(pwd, Math.max(1, width));

		const rightSide = this.showModelStatus ? formatModelStatusLabel(this.state) : "";

		let titleLine = "";
		const secondaryLine = renderSplitLine({
			width,
			leftText: this.showExitHint ? "Press Ctrl+C again to exit" : rightSide,
			rightText: pwd,
			leftStyle: (text) => theme.fg(this.showExitHint ? "text" : "dim", text),
			rightStyle: (text) => theme.fg("dim", text),
			leftTruncation: "end",
			minimumLeftWidth: 14,
		});

		titleLine = this.title
			? renderSplitLine({
					width,
					leftText: "",
					rightText: this.title,
					leftStyle: (text) => text,
					rightStyle: (text) => theme.fg("dim", text),
				})
			: "";

		if (this.transientStatus) {
			const workingIndicatorColor = theme.getFgAnsi(
				theme.getThinkingBorderThemeColor(this.state.thinkingLevel || "off"),
			);
			const workingLines = splitWorkingFooterMessage(this.transientStatus.message);
			const workingLine = renderSplitLine({
				width,
				leftText: `${this.transientStatus.indicator} ${workingLines.primary}`,
				rightText: this.showExitHint ? "" : (this.title ?? ""),
				leftStyle: (text) => {
					const spaceIndex = text.indexOf(" ");
					if (spaceIndex === -1) {
						return styleWorkingIndicator(text, workingIndicatorColor);
					}
					const indicator = text.slice(0, spaceIndex);
					const message = text.slice(spaceIndex + 1);
					return `${styleWorkingIndicator(indicator, workingIndicatorColor)} ${theme.fg("muted", message)}`;
				},
				rightStyle: (text) => theme.fg("dim", text),
				minimumLeftWidth: 12,
			});

			const workingDetailLine = renderSplitLine({
				width,
				leftText: workingLines.secondary,
				rightText: pwd,
				leftStyle: (text) => theme.fg("muted", text),
				rightStyle: (text) => theme.fg("dim", text),
				leftTruncation: "end",
				minimumLeftWidth: 14,
			});

			return [workingLine, workingDetailLine];
		}

		if (titleLine.length > 0) {
			return [titleLine, secondaryLine];
		}

		return [secondaryLine];
	}
}

export function formatModelStatusLabel(state: AgentState): string {
	const modelName = state.model?.id || "no-model";
	const providerName = state.model?.provider;

	let label = modelName;
	if (state.model?.reasoning) {
		const thinkingLevel = state.thinkingLevel || "off";
		const canShowXhigh = state.model ? supportsXhigh(state.model) : false;
		if (thinkingLevel !== "off" && (thinkingLevel !== "xhigh" || canShowXhigh)) {
			label = `${modelName} • ${thinkingLevel}`;
		}
	}

	if (supportsFastMode(state.model) && state.fastMode) {
		label = `${label} • fast`;
	}

	if (providerName) {
		label = `${label} [${providerName}]`;
	}

	return label;
}
