import type { Component } from "@kennyfrc/mu-tui";
import { theme } from "../theme/theme.js";

/**
 * Dynamic border component that adjusts to viewport width
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
