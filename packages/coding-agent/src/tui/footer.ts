import type { AgentState } from "@kennyfrc/mu-agent-core";
import { supportsXhigh } from "@kennyfrc/mu-ai";
import { type Component, visibleWidth } from "@kennyfrc/mu-tui";
import { existsSync, type FSWatcher, readFileSync, watch } from "fs";
import { dirname, join } from "path";
import { supportsFastMode } from "../fast-mode.js";
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
	private showModelStatus = true;
	private transientStatusLine: string | null = null;

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

	setTransientStatusLine(line: string | null): void {
		this.transientStatusLine = line;
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

		// Truncate path if too long to fit width
		const maxPathLength = Math.max(20, width - 10); // Leave some margin
		if (pwd.length > maxPathLength) {
			const start = pwd.slice(0, Math.floor(maxPathLength / 2) - 2);
			const end = pwd.slice(-(Math.floor(maxPathLength / 2) - 1));
			pwd = `${start}...${end}`;
		}

		const rightSide = this.showModelStatus ? formatModelStatusLabel(this.state) : "";
		const rightSideWidth = visibleWidth(rightSide);

		let statsLine: string;
		if (rightSideWidth === 0) {
			statsLine = "";
		} else if (rightSideWidth <= width) {
			const padding = " ".repeat(width - rightSideWidth);
			statsLine = padding + rightSide;
		} else {
			const plainRightSide = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
			statsLine = plainRightSide.substring(0, width);
		}

		// Build first line: pwd on left, title on right (if available)
		let firstLine: string;
		let pwdLine = "";

		if (this.showExitHint) {
			firstLine = theme.fg("text", "Press Ctrl+C again to exit");
			pwdLine = firstLine;
		} else {
			const pwdStr = theme.fg("dim", pwd);
			pwdLine = pwdStr;
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

		if (this.transientStatusLine) {
			const left = pwdLine;
			const leftWidth = visibleWidth(left);
			const right = this.transientStatusLine;
			const rightWidth = visibleWidth(right);
			if (leftWidth + 2 + rightWidth <= width) {
				return [left + " ".repeat(width - leftWidth - rightWidth) + right];
			}
			if (rightWidth <= width) {
				const clippedLeft = visibleWidth(left) > Math.max(0, width - rightWidth - 2) ? "" : left;
				const clippedLeftWidth = visibleWidth(clippedLeft);
				const gap =
					clippedLeftWidth > 0
						? Math.max(2, width - clippedLeftWidth - rightWidth)
						: Math.max(0, width - rightWidth);
				return [clippedLeft + " ".repeat(gap) + right];
			}
			return [right.replace(/\x1b\[[0-9;]*m/g, "").slice(0, width)];
		}

		if (statsLine.length > 0) {
			return [firstLine, theme.fg("dim", statsLine)];
		}

		return [firstLine];
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
