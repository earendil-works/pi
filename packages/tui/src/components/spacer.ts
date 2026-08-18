import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
