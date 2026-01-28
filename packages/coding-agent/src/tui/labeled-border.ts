import type { Component } from "@kennyfrc/mu-tui";
import { theme } from "../theme/theme.js";

/**
 * A simple label component with top padding, like:
 *
 * Worked for 21s
 */
export class LabeledBorder implements Component {
	constructor(
		private label: string,
		private labelColor: (str: string) => string = (str) => theme.fg("muted", str),
	) {}

	invalidate(): void {
		// No cached state to invalidate
	}

	render(_width: number): string[] {
		// Add empty line for top padding, and left padding (1 space) to align with content
		return ["", " " + this.labelColor(this.label)];
	}
}
