import { Container, MouseRegion, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export const TOOL_CALL_GROUP_THRESHOLD = 6;

export function formatToolCallGroupSummary(
	toolNames: readonly string[],
	errorCount: number,
): { calls: string; counts: string; errors?: string } {
	const counts = new Map<string, number>();
	for (const toolName of toolNames) {
		counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
	}

	return {
		calls: `${toolNames.length} tool calls`,
		counts: [...counts.entries()]
			.map(([toolName, count]) => `${count} ${toolName.charAt(0).toUpperCase()}${toolName.slice(1)}`)
			.join(" "),
		errors: errorCount > 0 ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : undefined,
	};
}

/** A collapsible transcript entry for a consecutive run of tool calls. */
export class ToolCallGroupComponent extends Container {
	private readonly tools: ToolExecutionComponent[];
	private readonly header: Text;
	private readonly toolsContainer = new Container();
	private readonly ui: TUI;
	private expanded: boolean;

	constructor(tools: readonly ToolExecutionComponent[], ui: TUI, expanded = false) {
		super();
		this.tools = [...tools];
		this.ui = ui;
		this.expanded = expanded;
		this.header = new Text("", 1, 0);
		this.addChild(
			new MouseRegion(this.header, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setGroupExpanded(!this.expanded);
				return { handled: true, render: true };
			}),
		);
		this.addChild(this.toolsContainer);
		this.updateDisplay();
	}

	addTool(tool: ToolExecutionComponent): void {
		this.tools.push(tool);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		for (const tool of this.tools) {
			tool.setExpanded(expanded);
		}
		this.setGroupExpanded(expanded);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		// Tool results can settle between renders, so refresh the aggregate error count here.
		this.updateDisplay();
		return super.render(width);
	}

	private setGroupExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
		this.ui.requestRender();
	}

	private updateDisplay(): void {
		const summary = formatToolCallGroupSummary(
			this.tools.map((tool) => tool.getToolName()),
			this.tools.filter((tool) => tool.isError()).length,
		);
		let text = theme.fg("muted", this.expanded ? "▾" : "▸");
		text += ` ${theme.fg("toolTitle", summary.calls)}`;
		if (summary.counts) text += ` ${theme.fg("muted", summary.counts)}`;
		if (summary.errors) text += ` ${theme.fg("error", summary.errors)}`;
		text += ` ${theme.fg("accent", this.expanded ? "collapse" : "expand")}`;
		this.header.setText(text);

		this.toolsContainer.clear();
		for (const tool of this.tools) {
			if (this.expanded || tool.isError()) {
				this.toolsContainer.addChild(tool);
			}
		}
	}
}
