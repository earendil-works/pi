/**
 * Tab bar component — renders a single-line strip of tab labels.
 *
 * Active tab is highlighted. Clicking (future: mouse support) or keyboard
 * shortcuts switch between tabs.
 */

import { type Component, visibleWidth } from "@mariozechner/pi-tui";
import type { Tab } from "../tab-manager.js";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const ACTIVE_PREFIX = "\x1b[1;36m"; // bold cyan
const INACTIVE_PREFIX = "\x1b[90m"; // gray
const RESET = "\x1b[0m";
const SEPARATOR = " │ ";

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

export class TabBar implements Component {
	private tabs: readonly Tab[] = [];
	private activeIndex = 0;
	setTabs(tabs: readonly Tab[], activeIndex: number): void {
		this.tabs = tabs;
		this.activeIndex = activeIndex;
	}

	render(width: number): string[] {
		if (this.tabs.length <= 1) {
			// Single tab — no bar needed
			return [];
		}

		const parts: string[] = [];
		for (let i = 0; i < this.tabs.length; i++) {
			const tab = this.tabs[i];
			const label = tab.label || `Tab ${i + 1}`;
			if (i === this.activeIndex) {
				parts.push(`${ACTIVE_PREFIX}[ ${label} ]${RESET}`);
			} else {
				parts.push(`${INACTIVE_PREFIX}  ${label}  ${RESET}`);
			}
		}

		const line = parts.join(SEPARATOR);
		// Pad to width
		const vis = visibleWidth(line);
		const padded = vis < width ? line + " ".repeat(width - vis) : line;
		return [padded];
	}

	invalidate(): void {
		// No-op: render() recomputes from tabs/activeIndex each time
	}
}
