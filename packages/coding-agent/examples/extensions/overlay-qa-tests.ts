/**
 * Overlay QA Tests - comprehensive overlay positioning and edge case tests
 *
 * Usage: pi --extension ./examples/extensions/overlay-qa-tests.ts
 *
 * Commands:
 *   /overlay-animation  - Real-time animation demo (~30 FPS, proves DOOM-like rendering works)
 *   /overlay-anchors    - Cycle through all 9 anchor positions
 *   /overlay-margins    - Test margin and offset options
 *   /overlay-stack      - Test stacked overlays
 *   /overlay-overflow   - Test width overflow with streaming process output
 *   /overlay-edge       - Test overlay positioned at terminal edge
 *   /overlay-percent    - Test percentage-based positioning
 *   /overlay-maxheight  - Test maxHeight truncation
 *   /overlay-sidepanel  - Responsive sidepanel (hides when terminal < 100 cols)
 *   /overlay-toggle     - Toggle visibility demo (demonstrates OverlayHandle.setHidden)
 *   /overlay-passive    - Non-capturing overlay demo (passive info panel alongside active overlay)
 *   /overlay-focus      - Focus cycling and rendering order with non-capturing overlays
 *   /overlay-streaming  - Multiple input panels with simulated streaming (Tab to cycle focus)
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayAnchor, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";

// Global handle for toggle demo (in real code, use a more elegant pattern)
let globalToggleHandle: OverlayHandle | null = null;

export default function (pi: ExtensionAPI) {
	// Animation demo - proves overlays can handle real-time updates (like pi-doom would need)
	pi.registerCommand("overlay-animation", {
		description: "Test real-time animation in overlay (~30 FPS)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new AnimationDemoComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 20 },
			});
		},
	});

	// Test all 9 anchor positions
	pi.registerCommand("overlay-anchors", {
		description: "Cycle through all anchor positions",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const anchors: OverlayAnchor[] = [
				"top-left",
				"top-center",
				"top-right",
				"left-center",
				"center",
				"right-center",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			];

			let index = 0;
			while (true) {
				const result = await ctx.ui.custom<"next" | "confirm" | "cancel">(
					(_tui, theme, _kb, done) => new AnchorTestComponent(theme, anchors[index]!, done),
					{
						overlay: true,
						overlayOptions: { anchor: anchors[index], width: 40 },
					},
				);

				if (result === "next") {
					index = (index + 1) % anchors.length;
					continue;
				}
				if (result === "confirm") {
					ctx.ui.notify(`Selected: ${anchors[index]}`, "info");
				}
				break;
			}
		},
	});

	// Test margins and offsets
	pi.registerCommand("overlay-margins", {
		description: "Test margin and offset options",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs: { name: string; options: OverlayOptions }[] = [
				{ name: "No margin (top-left)", options: { anchor: "top-left", width: 35 } },
				{ name: "Margin: 3 all sides", options: { anchor: "top-left", width: 35, margin: 3 } },
				{
					name: "Margin: top=5, left=10",
					options: { anchor: "top-left", width: 35, margin: { top: 5, left: 10 } },
				},
				{ name: "Center + offset (10, -3)", options: { anchor: "center", width: 35, offsetX: 10, offsetY: -3 } },
				{ name: "Bottom-right, margin: 2", options: { anchor: "bottom-right", width: 35, margin: 2 } },
			];

			let index = 0;
			while (true) {
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new MarginTestComponent(theme, configs[index]!, done),
					{
						overlay: true,
						overlayOptions: configs[index]!.options,
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test stacked overlays
	pi.registerCommand("overlay-stack", {
		description: "Test stacked overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Three large overlays that overlap in the center area
			// Each offset slightly so you can see the stacking

			ctx.ui.notify("Showing overlay 1 (back)...", "info");
			const p1 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 1, "back (red border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: -8, offsetY: -4, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 2 (middle)...", "info");
			const p2 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 2, "middle (green border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 0, offsetY: 0, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 3 (front)...", "info");
			const p3 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 3, "front (blue border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 8, offsetY: 4, maxHeight: 15 },
				},
			);

			// Wait for all to close
			const results = await Promise.all([p1, p2, p3]);
			ctx.ui.notify(`Closed in order: ${results.join(", ")}`, "info");
		},
	});

	// Test width overflow scenarios (original crash case) - streams real process output
	pi.registerCommand("overlay-overflow", {
		description: "Test width overflow with streaming process output",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingOverflowComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 90, maxHeight: 20 },
			});
		},
	});

	// Test overlay at terminal edge
	pi.registerCommand("overlay-edge", {
		description: "Test overlay positioned at terminal edge",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new EdgeTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "right-center", width: 40, margin: { right: 0 } },
			});
		},
	});

	// Test percentage-based positioning
	pi.registerCommand("overlay-percent", {
		description: "Test percentage-based positioning",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs = [
				{ name: "rowPercent: 0 (top)", row: 0, col: 50 },
				{ name: "rowPercent: 50 (middle)", row: 50, col: 50 },
				{ name: "rowPercent: 100 (bottom)", row: 100, col: 50 },
				{ name: "colPercent: 0 (left)", row: 50, col: 0 },
				{ name: "colPercent: 100 (right)", row: 50, col: 100 },
			];

			let index = 0;
			while (true) {
				const config = configs[index]!;
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new PercentTestComponent(theme, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: 30,
							row: `${config.row}%`,
							col: `${config.col}%`,
						},
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test maxHeight
	pi.registerCommand("overlay-maxheight", {
		description: "Test maxHeight truncation",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new MaxHeightTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 10 },
			});
		},
	});

	// Test responsive sidepanel - only shows when terminal is wide enough
	pi.registerCommand("overlay-sidepanel", {
		description: "Test responsive sidepanel (hides when terminal < 100 cols)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new SidepanelComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "25%",
					minWidth: 30,
					margin: { right: 1 },
					// Only show when terminal is wide enough
					visible: (termWidth) => termWidth >= 100,
				},
			});
		},
	});

	// Test toggle overlay - demonstrates OverlayHandle.setHidden() via onHandle callback
	pi.registerCommand("overlay-toggle", {
		description: "Test overlay toggle (press 't' to toggle visibility)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new ToggleDemoComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50 },
				// onHandle callback provides access to the OverlayHandle for visibility control
				onHandle: (handle) => {
					// Store handle globally so component can access it
					// (In real code, you'd use a more elegant pattern like a store or event emitter)
					globalToggleHandle = handle;
				},
			});
			globalToggleHandle = null;
		},
	});

	// Non-capturing overlay demo - passive info panel that doesn't steal focus
	pi.registerCommand("overlay-passive", {
		description: "Test non-capturing overlay (passive info panel alongside active overlay)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new PassiveDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 48 },
			});
		},
	});

	// Focus cycling demo - demonstrates focus(), unfocus(), isFocused() and rendering order
	pi.registerCommand("overlay-focus", {
		description: "Test focus cycling and rendering order with non-capturing overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new FocusDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 55, margin: { bottom: 1 } },
			});
		},
	});

	// Test multiple input panels with simulated streaming
	pi.registerCommand("overlay-streaming", {
		description: "Multiple input panels with simulated streaming (Tab to cycle focus)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingInputController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 60, margin: { bottom: 1 } },
			});
		},
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Base overlay component with common rendering
abstract class BaseOverlay {
	protected theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	protected box(lines: string[], width: number, title?: string): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const result: string[] = [];

		const titleStr = title ? truncateToWidth(` ${title} `, innerW) : "";
		const titleW = visibleWidth(titleStr);
		const topLine = "─".repeat(Math.floor((innerW - titleW) / 2));
		const topLine2 = "─".repeat(Math.max(0, innerW - titleW - topLine.length));
		result.push(th.fg("border", `╭${topLine}`) + th.fg("accent", titleStr) + th.fg("border", `${topLine2}╮`));

		for (const line of lines) {
			result.push(th.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + th.fg("border", "│"));
		}

		result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return result;
	}

	invalidate(): void {}
	dispose(): void {}
}

// Anchor position test
class AnchorTestComponent extends BaseOverlay {
	private anchor: OverlayAnchor;
	private done: (result: "next" | "confirm" | "cancel") => void;

	constructor(theme: Theme, anchor: OverlayAnchor, done: (result: "next" | "confirm" | "cancel") => void) {
		super(theme);
		this.anchor = anchor;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("cancel");
		} else if (matchesKey(data, "return")) {
			this.done("confirm");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` Current: ${th.fg("accent", this.anchor)}`,
				"",
				` ${th.fg("dim", "Space/→ = next anchor")}`,
				` ${th.fg("dim", "Enter = confirm")}`,
				` ${th.fg("dim", "Esc = cancel")}`,
				"",
			],
			width,
			"Anchor Test",
		);
	}
}

// Margin/offset test
class MarginTestComponent extends BaseOverlay {
	private config: { name: string; options: OverlayOptions };
	private done: (result: "next" | "close") => void;

	constructor(
		theme: Theme,
		config: { name: string; options: OverlayOptions },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next config")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Margin Test",
		);
	}
}

// Stacked overlay test
class StackOverlayComponent extends BaseOverlay {
	private num: number;
	private position: string;
	private done: (result: string) => void;

	constructor(theme: Theme, num: number, position: string, done: (result: string) => void) {
		super(theme);
		this.num = num;
		this.position = position;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
			this.done(`Overlay ${this.num}`);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		// Use different colors for each overlay to show stacking
		const colors = ["error", "success", "accent"] as const;
		const color = colors[(this.num - 1) % colors.length]!;
		const innerW = Math.max(1, width - 2);
		const border = (char: string) => th.fg(color, char);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` Overlay ${th.fg("accent", `#${this.num}`)}`) + border("│"));
		lines.push(border("│") + padLine(` Layer: ${th.fg(color, this.position)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		// Add extra lines to make it taller
		for (let i = 0; i < 5; i++) {
			lines.push(border("│") + padLine(` ${"░".repeat(innerW - 2)} `) + border("│"));
		}
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Enter/Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Streaming overflow test - spawns real process with colored output (original crash scenario)
class StreamingOverflowComponent extends BaseOverlay {
	private tui: TUI;
	private lines: string[] = [];
	private proc: ReturnType<typeof spawn> | null = null;
	private scrollOffset = 0;
	private maxVisibleLines = 15;
	private finished = false;
	private disposed = false;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startProcess();
	}

	private startProcess(): void {
		// Run a command that produces many lines with ANSI colors
		// Using find with -ls produces file listings, or use ls --color
		this.proc = spawn("bash", [
			"-c",
			`
			echo "Starting streaming overflow test (30+ seconds)..."
			echo "This simulates subagent output with colors, hyperlinks, and long paths"
			echo ""
			for i in $(seq 1 100); do
				# Simulate long file paths with OSC 8 hyperlinks (clickable) - tests width overflow
				DIR="/Users/nicobailon/Documents/development/pi-mono/packages/coding-agent/src/modes/interactive"
				FILE="\${DIR}/components/very-long-component-name-that-exceeds-width-\${i}.ts"
				echo -e "\\033]8;;file://\${FILE}\\007▶ read: \${FILE}\\033]8;;\\007"

				# Add some colored status messages with long text
				if [ $((i % 5)) -eq 0 ]; then
					echo -e "  \\033[32m✓ Successfully processed \${i} files in /Users/nicobailon/Documents/development/pi-mono\\033[0m"
				fi
				if [ $((i % 7)) -eq 0 ]; then
					echo -e "  \\033[33m⚠ Warning: potential issue detected at line \${i} in very-long-component-name-that-exceeds-width.ts\\033[0m"
				fi
				if [ $((i % 11)) -eq 0 ]; then
					echo -e "  \\033[31m✗ Error: file not found /some/really/long/path/that/definitely/exceeds/the/overlay/width/limit/file-\${i}.ts\\033[0m"
				fi
				sleep 0.3
			done
			echo ""
			echo -e "\\033[32m✓ Complete - 100 files processed in 30 seconds\\033[0m"
			echo "Press Esc to close"
			`,
		]);

		this.proc.stdout?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			const text = data.toString();
			const newLines = text.split("\n");
			for (const line of newLines) {
				if (line) this.lines.push(line);
			}
			// Auto-scroll to bottom
			this.scrollOffset = Math.max(0, this.lines.length - this.maxVisibleLines);
			this.tui.requestRender();
		});

		this.proc.stderr?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.lines.push(this.theme.fg("error", data.toString().trim()));
			this.tui.requestRender();
		});

		this.proc.on("close", () => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.finished = true;
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.proc?.kill();
			this.done();
		} else if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		} else if (matchesKey(data, "down")) {
			this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.maxVisibleLines), this.scrollOffset + 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const result: string[] = [];
		const title = truncateToWidth(` Streaming Output (${this.lines.length} lines) `, innerW);
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		result.push(border("╭") + th.fg("accent", title) + border(`${"─".repeat(titlePad)}╮`));

		// Scroll indicators
		const canScrollUp = this.scrollOffset > 0;
		const canScrollDown = this.scrollOffset < this.lines.length - this.maxVisibleLines;
		const scrollInfo = `↑${this.scrollOffset} | ↓${Math.max(0, this.lines.length - this.maxVisibleLines - this.scrollOffset)}`;

		result.push(
			border("│") + padLine(canScrollUp || canScrollDown ? th.fg("dim", ` ${scrollInfo}`) : "") + border("│"),
		);

		// Visible lines - truncate long lines to fit within border
		const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
		for (const line of visibleLines) {
			result.push(border("│") + padLine(` ${line}`) + border("│"));
		}

		// Pad to maxVisibleLines
		for (let i = visibleLines.length; i < this.maxVisibleLines; i++) {
			result.push(border("│") + padLine("") + border("│"));
		}

		const status = this.finished ? th.fg("success", "✓ Done") : th.fg("warning", "● Running");
		result.push(border("│") + padLine(` ${status} ${th.fg("dim", "| ↑↓ scroll | Esc close")}`) + border("│"));
		result.push(border(`╰${"─".repeat(innerW)}╯`));

		return result;
	}

	dispose(): void {
		this.disposed = true;
		this.proc?.kill();
	}
}

// Edge position test
class EdgeTestComponent extends BaseOverlay {
	private done: () => void;

	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				" This overlay is at the",
				" right edge of terminal.",
				"",
				` ${th.fg("dim", "Verify right border")}`,
				` ${th.fg("dim", "aligns with edge.")}`,
				"",
				` ${th.fg("dim", "Press Esc to close")}`,
				"",
			],
			width,
			"Edge Test",
		);
	}
}

// Percentage positioning test
class PercentTestComponent extends BaseOverlay {
	private config: { name: string; row: number; col: number };
	private done: (result: "next" | "close") => void;

	constructor(
		theme: Theme,
		config: { name: string; row: number; col: number },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Percent Test",
		);
	}
}

// MaxHeight test - renders 20 lines, truncated to 10 by maxHeight
class MaxHeightTestComponent extends BaseOverlay {
	private done: () => void;

	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		// Intentionally render 21 lines - maxHeight: 10 will truncate to first 10
		// You should see header + lines 1-6, with bottom border cut off
		const contentLines: string[] = [
			th.fg("warning", " ⚠ Rendering 21 lines, maxHeight: 10"),
			th.fg("dim", " Lines 11-21 truncated (no bottom border)"),
			"",
		];

		for (let i = 1; i <= 14; i++) {
			contentLines.push(` Line ${i} of 14`);
		}

		contentLines.push("", th.fg("dim", " Press Esc to close"));

		return this.box(contentLines, width, "MaxHeight Test");
	}
}

// Responsive sidepanel - demonstrates percentage width and visibility callback
class SidepanelComponent extends BaseOverlay {
	private tui: TUI;
	private items = ["Dashboard", "Messages", "Settings", "Help", "About"];
	private selectedIndex = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		} else if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			// Could trigger an action here
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		// Header
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Responsive Sidepanel")) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Menu items
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const text = isSelected ? th.fg("accent", item) : item;
			lines.push(border("│") + padLine(`${prefix}${text}`) + border("│"));
		}

		// Footer with responsive behavior info
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("warning", " ⚠ Resize terminal < 100 cols")) + border("│"));
		lines.push(border("│") + padLine(th.fg("warning", "   to see panel auto-hide")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Uses visible: (w) => w >= 100")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate | Esc close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Animation demo - proves overlays can handle real-time updates like pi-doom
class AnimationDemoComponent extends BaseOverlay {
	private tui: TUI;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private fps = 0;
	private lastFpsUpdate = Date.now();
	private framesSinceLastFps = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startAnimation();
	}

	private startAnimation(): void {
		// Run at ~30 FPS (same as DOOM target)
		this.interval = setInterval(() => {
			this.frame++;
			this.framesSinceLastFps++;

			// Update FPS counter every second
			const now = Date.now();
			if (now - this.lastFpsUpdate >= 1000) {
				this.fps = this.framesSinceLastFps;
				this.framesSinceLastFps = 0;
				this.lastFpsUpdate = now;
			}

			this.tui.requestRender();
		}, 1000 / 30);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Animation Demo (~30 FPS)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(` Frame: ${th.fg("accent", String(this.frame))}`) + border("│"));
		lines.push(border("│") + padLine(` FPS: ${th.fg("success", String(this.fps))}`) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));

		// Animated content - bouncing bar
		const barWidth = Math.max(12, innerW - 4); // Ensure enough space for bar
		const pos = Math.max(0, Math.floor(((Math.sin(this.frame / 10) + 1) * (barWidth - 10)) / 2));
		const bar = " ".repeat(pos) + th.fg("accent", "██████████") + " ".repeat(Math.max(0, barWidth - 10 - pos));
		lines.push(border("│") + padLine(` ${bar}`) + border("│"));

		// Spinning character
		const spinChars = ["◐", "◓", "◑", "◒"];
		const spin = spinChars[this.frame % spinChars.length];
		lines.push(border("│") + padLine(` Spinner: ${th.fg("warning", spin!)}`) + border("│"));

		// Color cycling
		const hue = (this.frame * 3) % 360;
		const rgb = hslToRgb(hue / 360, 0.8, 0.5);
		const colorBlock = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${"  ".repeat(10)}\x1b[0m`;
		lines.push(border("│") + padLine(` Color: ${colorBlock}`) + border("│"));

		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " This proves overlays can handle")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " real-time game-like rendering.")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " (pi-doom uses same approach)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

// HSL to RGB helper for color cycling animation
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	let r: number, g: number, b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const hue2rgb = (p: number, q: number, t: number) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Toggle demo - demonstrates OverlayHandle.setHidden() via onHandle callback
class ToggleDemoComponent extends BaseOverlay {
	private tui: TUI;
	private toggleCount = 0;
	private isToggling = false;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		} else if (matchesKey(data, "t") && globalToggleHandle && !this.isToggling) {
			// Demonstrate toggle by hiding for 1 second then showing again
			// (In real usage, a global keybinding would control visibility)
			this.isToggling = true;
			this.toggleCount++;
			globalToggleHandle.setHidden(true);

			// Auto-restore after 1 second to demonstrate the API
			setTimeout(() => {
				if (globalToggleHandle) {
					globalToggleHandle.setHidden(false);
					this.isToggling = false;
					this.tui.requestRender();
				}
			}, 1000);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				th.fg("accent", " Toggle Demo"),
				"",
				" This overlay demonstrates the",
				" onHandle callback API.",
				"",
				` Toggle count: ${th.fg("accent", String(this.toggleCount))}`,
				"",
				th.fg("dim", " Press 't' to hide for 1 second"),
				th.fg("dim", " (demonstrates setHidden API)"),
				"",
				th.fg("dim", " In real usage, a global keybinding"),
				th.fg("dim", " would toggle visibility externally."),
				"",
				th.fg("dim", " Press Esc to close"),
				"",
			],
			width,
			"Toggle Demo",
		);
	}
}

// === Non-capturing passive overlay demo ===

class PassiveDemoController extends BaseOverlay {
	focused = false;
	private tui: TUI;
	private typed = "";
	private timerComponent: TimerPanel;
	private timerHandle: OverlayHandle | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private inputCount = 0;
	private lastInputDebug = "";
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.timerComponent = new TimerPanel(theme);
		this.timerHandle = this.tui.showOverlay(this.timerComponent, {
			nonCapturing: true,
			anchor: "top-right",
			width: 22,
			margin: { top: 1, right: 2 },
		});
		this.interval = setInterval(() => {
			this.timerComponent.tick();
			this.tui.requestRender();
		}, 1000);
	}

	handleInput(data: string): void {
		this.inputCount++;
		this.lastInputDebug = `len=${data.length} c0=${data.charCodeAt(0)}`;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done();
		} else if (matchesKey(data, "backspace")) {
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.typed += data;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const display = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		return this.box(
			[
				"",
				` ${th.fg("dim", `focused=${this.focused} inputs=${this.inputCount}`)}`,
				` ${th.fg("dim", `last: ${this.lastInputDebug || "none"}`)}`,
				"",
				` > ${display}`,
				"",
				th.fg("dim", " Type to prove input goes here."),
				th.fg("dim", " Press Esc to close both."),
				"",
			],
			width,
			"Non-Capturing Demo",
		);
	}

	private cleanup(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		this.timerHandle?.hide();
		this.timerHandle = null;
	}

	override dispose(): void {
		this.cleanup();
	}
}

class TimerPanel extends BaseOverlay {
	private seconds = 0;

	tick(): void {
		this.seconds++;
	}

	render(width: number): string[] {
		const th = this.theme;
		const mins = Math.floor(this.seconds / 60);
		const secs = this.seconds % 60;
		const time = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
		return this.box([` ${th.fg("accent", time)}`, th.fg("dim", " nonCapturing: true")], width, "Timer");
	}
}

// === Focus cycling demo ===

class FocusDemoController extends BaseOverlay {
	private tui: TUI;
	private panels: FocusPanel[] = [];
	private handles: OverlayHandle[] = [];
	private focusIndex = -1;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		const colors = ["error", "success", "accent"] as const;
		const labels = ["Alpha", "Beta", "Gamma"];

		for (let i = 0; i < 3; i++) {
			const panel = new FocusPanel(
				theme,
				labels[i]!,
				colors[i]!,
				() => this.cycleFocus(),
				() => this.close(),
			);
			const handle = this.tui.showOverlay(panel, {
				nonCapturing: true,
				row: 2,
				col: 5 + i * 6,
				width: 28,
			});
			panel.handle = handle;
			this.panels.push(panel);
			this.handles.push(handle);
		}
	}

	private cycleFocus(): void {
		if (this.focusIndex >= 0 && this.focusIndex < this.handles.length) {
			this.handles[this.focusIndex]!.unfocus();
		}
		this.focusIndex++;
		if (this.focusIndex >= this.handles.length) {
			this.focusIndex = -1;
		} else {
			this.handles[this.focusIndex]!.focus();
		}
		this.tui.requestRender();
	}

	private close(): void {
		for (const handle of this.handles) handle.hide();
		this.handles = [];
		this.panels = [];
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.cycleFocus();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focused = this.focusIndex === -1 ? "Controller" : (this.panels[this.focusIndex]?.label ?? "?");
		return this.box(
			[
				"",
				` Current focus: ${th.fg("accent", focused)}`,
				"",
				" Three overlapping panels above are",
				` all ${th.fg("accent", "nonCapturing")}. Press Tab to`,
				" cycle focus() between them.",
				"",
				" Focused panel renders on top",
				" (focus-based rendering order).",
				"",
				th.fg("dim", " Tab = cycle focus | Esc = close"),
				"",
			],
			width,
			"Focus Demo",
		);
	}

	override dispose(): void {
		for (const handle of this.handles) handle.hide();
	}
}

class FocusPanel extends BaseOverlay {
	handle: OverlayHandle | null = null;
	readonly label: string;
	private color: "error" | "success" | "accent";
	private onTab: () => void;
	private onClose: () => void;

	constructor(
		theme: Theme,
		label: string,
		color: "error" | "success" | "accent",
		onTab: () => void,
		onClose: () => void,
	) {
		super(theme);
		this.label = label;
		this.color = color;
		this.onTab = onTab;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.onTab();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focused = this.handle?.isFocused() ?? false;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.color, c);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` ${th.fg("accent", this.label)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		if (focused) {
			lines.push(border("│") + padLine(th.fg("success", " ● FOCUSED")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " (receiving input)")) + border("│"));
		} else {
			lines.push(border("│") + padLine(th.fg("dim", " ○ unfocused")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " (passive)")) + border("│"));
		}
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// === Streaming input panel test (/overlay-streaming) ===

class StreamingInputController extends BaseOverlay {
	private tui: TUI;
	private panels: StreamingInputPanel[] = [];
	private handles: OverlayHandle[] = [];
	private focusIndex = -1; // -1 = controller focused, 0-2 = panel focused
	private streamLines: string[] = [];
	private streamInterval: ReturnType<typeof setInterval> | null = null;
	private lineCount = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;

		// Create 3 input panels as non-capturing overlays
		const colors = ["error", "success", "accent"] as const;
		const labels = ["Panel A", "Panel B", "Panel C"];

		for (let i = 0; i < 3; i++) {
			const panel = new StreamingInputPanel(
				theme,
				labels[i]!,
				colors[i]!,
				() => this.cycleFocus(),
				() => this.close(),
			);
			const handle = this.tui.showOverlay(panel, {
				nonCapturing: true,
				row: 1 + i * 9,
				col: 2,
				width: 35,
			});
			panel.handle = handle;
			this.panels.push(panel);
			this.handles.push(handle);
		}

		// Start with controller focused (focusIndex = -1)

		// Start simulated streaming
		this.streamInterval = setInterval(() => {
			this.lineCount++;
			const timestamp = new Date().toLocaleTimeString();
			this.streamLines.push(`[${timestamp}] Streaming line ${this.lineCount}...`);
			if (this.streamLines.length > 8) {
				this.streamLines.shift();
			}
			this.tui.requestRender();
		}, 500);
	}

	private cycleFocus(): void {
		// Unfocus current panel if any
		if (this.focusIndex >= 0 && this.focusIndex < this.handles.length) {
			this.handles[this.focusIndex]!.unfocus();
		}

		// Cycle: -1 (controller) → 0 → 1 → 2 → -1 ...
		this.focusIndex++;
		if (this.focusIndex >= this.handles.length) {
			this.focusIndex = -1; // Back to controller
		}

		// Focus new panel if any
		if (this.focusIndex >= 0) {
			this.handles[this.focusIndex]!.focus();
		}

		this.tui.requestRender();
	}

	private close(): void {
		if (this.streamInterval) {
			clearInterval(this.streamInterval);
			this.streamInterval = null;
		}
		for (const handle of this.handles) handle.hide();
		this.handles = [];
		this.panels = [];
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.cycleFocus();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focusedLabel =
			this.focusIndex === -1
				? th.fg("success", "Controller (this panel)")
				: (this.panels[this.focusIndex]?.label ?? "?");

		const lines = [
			"",
			` Current focus: ${th.fg("accent", focusedLabel)}`,
			"",
			" Simulated streaming output:",
			th.fg("dim", " ─".repeat((width - 2) / 2)),
		];

		for (const line of this.streamLines) {
			lines.push(` ${th.fg("dim", line)}`);
		}

		while (lines.length < 12) {
			lines.push("");
		}

		lines.push(th.fg("dim", " ─".repeat((width - 2) / 2)));
		lines.push("");
		lines.push(` Three ${th.fg("accent", "nonCapturing")} input panels on the left.`);
		lines.push(" Tab cycles: Controller → Panel A → B → C → Controller");
		lines.push(" Type in each panel to test input routing.");
		lines.push("");
		lines.push(th.fg("dim", " Tab = cycle focus | Esc = close all"));
		lines.push("");

		return this.box(lines, width, "Streaming + Input Test");
	}

	override dispose(): void {
		this.close();
	}
}

class StreamingInputPanel implements Component {
	handle: OverlayHandle | null = null;
	private theme: Theme;
	private typed = "";
	readonly label: string;
	private color: "error" | "success" | "accent";
	private onTab: () => void;
	private onClose: () => void;

	constructor(
		theme: Theme,
		label: string,
		color: "error" | "success" | "accent",
		onTab: () => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.label = label;
		this.color = color;
		this.onTab = onTab;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.onTab();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		} else if (matchesKey(data, "backspace")) {
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.typed += data;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focused = this.handle?.isFocused() ?? false;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.color, c);
		const padLine = (s: string) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - w));
		};

		const inputDisplay = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		const truncatedInput = truncateToWidth(` > ${inputDisplay}`, innerW, "...", true);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` ${th.fg("accent", this.label)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		if (focused) {
			lines.push(border("│") + padLine(th.fg("success", " ● FOCUSED")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " (receiving input)")) + border("│"));
		} else {
			lines.push(border("│") + padLine(th.fg("dim", " ○ unfocused")) + border("│"));
			lines.push(border("│") + padLine("") + border("│"));
		}
		lines.push(border("│") + padLine(truncatedInput) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Tab | Esc")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
}
