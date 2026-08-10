import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { formatCwdForFooter, formatTokens } from "./footer.ts";

/**
 * Fixed single-line top bar for fullscreen mode only.
 * Left: home-abbreviated cwd and optional git branch.
 * Right: context usage (preserved under width pressure).
 */
export class FullscreenTopBar implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// No-op: data comes from session + FooterDataProvider each render
	}

	dispose(): void {
		// No resources owned; git watching lives on FooterDataProvider
	}

	render(width: number): string[] {
		if (width <= 0) {
			return [""];
		}

		const state = this.session.state;

		let left = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) {
			left = `${left} (${branch})`;
		}

		// Match FooterComponent context display exactly.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

		let rightColored: string;
		if (contextPercentValue > 90) {
			rightColored = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			rightColored = theme.fg("warning", contextPercentDisplay);
		} else {
			rightColored = contextPercentDisplay;
		}

		const rightPlain = contextPercentDisplay;
		const rightWidth = visibleWidth(rightPlain);
		const minPadding = 1;

		// Right side is preserved; if it alone exceeds width, truncate it.
		if (rightWidth >= width) {
			const truncatedRight = rightWidth > width ? truncateToWidth(rightPlain, width, "...") : rightPlain;
			// Re-apply color to truncated plain text when thresholds apply.
			let colored: string;
			if (contextPercentValue > 90) {
				colored = theme.fg("error", truncatedRight);
			} else if (contextPercentValue > 70) {
				colored = theme.fg("warning", truncatedRight);
			} else {
				colored = truncatedRight;
			}
			const pad = Math.max(0, width - visibleWidth(truncatedRight));
			return [colored + (pad > 0 ? " ".repeat(pad) : "")];
		}

		const availableForLeft = width - rightWidth - minPadding;
		let leftDisplay = left;
		if (availableForLeft <= 0) {
			// No room for left; show right only, left-padded so right stays at the end.
			const padding = " ".repeat(width - rightWidth);
			return [padding + rightColored];
		}

		if (visibleWidth(leftDisplay) > availableForLeft) {
			leftDisplay = truncateToWidth(leftDisplay, availableForLeft, "...");
		}

		const leftWidth = visibleWidth(leftDisplay);
		const padding = " ".repeat(Math.max(minPadding, width - leftWidth - rightWidth));
		const dimLeft = theme.fg("dim", leftDisplay);
		return [dimLeft + padding + rightColored];
	}
}
