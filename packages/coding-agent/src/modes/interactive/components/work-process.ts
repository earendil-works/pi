import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, MouseRegion, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * UI-only grouping of one agent request's tool-using work: assistant messages that issued tool
 * calls plus their tool execution components. Collapsing renders a single summary line; it never
 * touches session entries or the LLM context.
 *
 * The final assistant answer of a request is not held here; it stays a direct child of the chat
 * container so it remains visible while the work process is collapsed.
 */
export class WorkProcessComponent extends Container {
	private collapsed = false;
	private startedAt?: number;
	private completedAt?: number;
	private toolCounts = new Map<string, number>();
	private toolOrder: string[] = [];
	private erroredToolNames = new Set<string>();
	private thinkingPreview?: string;
	private headerText?: Text;
	private headerRegion?: MouseRegion;
	private headerLines = 0;

	constructor(startedAt?: number) {
		super();
		this.startedAt = startedAt;
	}

	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.invalidate();
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setCompleted(completedAt: number): void {
		this.completedAt = completedAt;
		this.invalidate();
	}

	setThinkingPreview(preview: string): void {
		if (this.thinkingPreview) return;
		this.thinkingPreview = preview;
		this.invalidate();
	}

	/** Record one tool execution for the summary line. */
	trackTool(name: string): void {
		const count = this.toolCounts.get(name) ?? 0;
		if (count === 0) {
			this.toolOrder.push(name);
		}
		this.toolCounts.set(name, count + 1);
		this.invalidate();
	}

	/** Mark that a tool execution of this name ended with an error. */
	markToolErrored(name: string): void {
		this.erroredToolNames.add(name);
		this.invalidate();
	}

	/** Children rendered below the summary header when expanded. */
	contentChildren(): readonly Component[] {
		return this.children;
	}

	override render(width: number): string[] {
		this.ensureHeader();
		const headerLines = this.headerRegion?.render(width) ?? [];
		this.headerLines = headerLines.length;
		const childLines = super.render(width);
		if (this.collapsed) {
			return headerLines;
		}
		return [...headerLines, ...childLines];
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.y >= 0 && event.y < this.headerLines) {
			if (event.type === "click" && event.button === "left") {
				this.setCollapsed(!this.collapsed);
				return {
					handled: true,
					target: {
						component: this,
						originX: event.screenX - event.x,
						originY: event.screenY - event.y,
						width: event.width,
						height: event.height,
					},
				};
			}
			return undefined;
		}
		return super.handleMouse({
			...event,
			y: event.y - this.headerLines,
			height: event.height - this.headerLines,
		});
	}

	private ensureHeader(): void {
		const line = this.renderHeaderLine();
		if (!this.headerText || !this.headerRegion) {
			this.headerText = new Text(line, 0, 0);
			this.headerRegion = new MouseRegion(this.headerText, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setCollapsed(!this.collapsed);
				return { handled: true };
			});
			return;
		}
		this.headerText.setText(line);
	}

	private renderHeaderLine(): string {
		const arrow = this.collapsed ? "▶" : "▼";
		const separator = theme.fg("muted", " · ");
		const parts: string[] = [];
		const duration = this.renderDuration();
		if (duration) parts.push(duration);
		const tools = this.renderToolSummary();
		if (tools) parts.push(tools);
		if (this.thinkingPreview) {
			parts.push(`${theme.fg("muted", "thinking: ")}${theme.fg("dim", this.thinkingPreview)}`);
		}
		const label = parts.join(separator);
		return `${theme.fg("accent", arrow)} ${theme.fg("toolTitle", label)}`;
	}

	private renderDuration(): string | undefined {
		if (this.startedAt === undefined) {
			return undefined;
		}
		const end = this.completedAt ?? Date.now();
		const seconds = Math.max(0, Math.floor((end - this.startedAt) / 1000));
		if (seconds < 60) {
			return `Worked ${seconds}s`;
		}
		return `Worked ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}

	private renderToolSummary(): string | undefined {
		if (this.toolOrder.length === 0) {
			return undefined;
		}
		return this.toolOrder
			.map((name) => {
				const count = this.toolCounts.get(name) ?? 1;
				const label = this.erroredToolNames.has(name) ? theme.fg("error", name) : name;
				return count > 1 ? `${label}×${count}` : label;
			})
			.join(theme.fg("muted", " "));
	}
}

/** Extracts the first thinking sentence of an assistant message for the summary line. */
export function extractThinkingPreview(message: AssistantMessage): string | undefined {
	for (const block of message.content) {
		if (block.type !== "thinking") continue;
		const text = block.thinking.trim();
		if (!text) continue;
		const collapsed = text.replace(/\s+/g, " ");
		const sentenceMatch = collapsed.match(/^[\s\S]*?[.!?\u3002\uff01\uff1f](\s|$)/);
		const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : collapsed;
		return firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}…` : firstSentence;
	}
	return undefined;
}
