// Copied from coding-agent interactive/components/tool-execution.ts. p2 drives a card from the transcript's ToolView
// (call, live slot and result joined, src/web/transcript.ts) instead of agent events; images stay text placeholders
// (no PNG transcoder, section 11); a tool without renderers uses pi's generic call/result fallbacks.
import { Box, type Component, Container, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolView } from "../../web/transcript.ts";
import type { RenderContext } from "../render-context.ts";
import { formatToolCallWithArgs, getTextOutput, moreLinesHint } from "../tools/render-utils.ts";
import type { ToolRenderContext, ToolRenderers, ToolResultView } from "../tools/types.ts";

const FALLBACK_PREVIEW_LINES = 10;

export type ToolCardContext = RenderContext & {
	/** The session cwd, for relative path display. */
	readonly cwd: string;
	readonly outputPad?: number;
};

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: Record<string, unknown> = {};
	private tool: ToolView;
	private argsComplete: boolean;
	private expanded = false;
	private renderers: ToolRenderers;
	private ctx: ToolCardContext;
	private hideComponent = false;
	private themeVersion: number;

	constructor(tool: ToolView, renderers: ToolRenderers | undefined, ctx: ToolCardContext, argsComplete = true) {
		super();
		this.tool = tool;
		this.argsComplete = argsComplete;
		this.renderers = renderers ?? {};
		this.ctx = ctx;
		this.themeVersion = ctx.theme.version;
		this.addChild(new Spacer(1));
		this.contentBox = new Box(1, 1, (text: string) => ctx.theme.current.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();
		this.addChild(this.renderers.renderShell === "self" ? this.selfRenderContainer : this.contentBox);
		this.updateDisplay();
	}

	get toolId(): string {
		return this.tool.id;
	}

	/** A new view of the same call (arguments, live slot, result). */
	update(tool: ToolView, argsComplete = true): void {
		if (tool === this.tool && argsComplete === this.argsComplete) return;
		this.tool = tool;
		this.argsComplete = argsComplete;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** Stops renderer timers (a running bash card's elapsed clock). */
	dispose(): void {
		const interval = this.rendererState.interval;
		if (interval !== undefined) clearInterval(interval as ReturnType<typeof setInterval>);
		this.rendererState.interval = undefined;
	}

	private get isPartial(): boolean {
		return this.tool.status === "pending" || this.tool.status === "running";
	}

	private get isError(): boolean {
		return this.tool.status === "error" || this.tool.status === "interrupted";
	}

	/** The result as pi's card holds it: absent until the call runs; partial while running. */
	private get result(): ToolResultView | undefined {
		const tool = this.tool;
		if (tool.status === "pending" && !tool.calls?.length) return undefined;
		const text = tool.output || (tool.status === "interrupted" ? "Not run: the answer was interrupted." : "");
		return {
			content: [...(text ? [{ type: "text" as const, text }] : []), ...tool.images],
			details: tool.details,
		};
	}

	private renderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.tool.args,
			toolCallId: this.tool.id,
			invalidate: () => {
				this.invalidate();
				this.ctx.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.ctx.cwd,
			executionStarted: this.tool.status !== "pending",
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: false,
			isError: this.isError,
			durationMs: this.isPartial ? undefined : this.tool.durationMs,
			outputPad: this.ctx.outputPad ?? 1,
			calls: this.tool.calls,
			ui: this.ctx,
		};
	}

	private createCallFallback(): Component {
		return new Text(
			formatToolCallWithArgs(this.tool.name, this.tool.args, this.ctx.theme.current, this.expanded),
			0,
			0,
		);
	}

	private createResultFallback(result: ToolResultView): Component | undefined {
		const theme = this.ctx.theme.current;
		const output = getTextOutput(result);
		if (!output) return undefined;
		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) text += `\n${moreLinesHint(this.ctx, theme, remaining)}`;
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			this.ctx.requestRender();
			return { handled: true };
		});
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		// Colors are baked into the content: rebuild after a theme swap (section 5.4).
		if (this.themeVersion !== this.ctx.theme.version) {
			this.themeVersion = this.ctx.theme.version;
			this.updateDisplay();
		}
		if (this.hideComponent) return [];
		if (this.renderers.renderShell === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			return contentLines.length > 0 ? ["", ...contentLines] : [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const theme = this.ctx.theme.current;
		const result = this.result;
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);
		let hasContent = false;
		const container = this.renderers.renderShell === "self" ? this.selfRenderContainer : this.contentBox;
		if (container instanceof Box) {
			container.setBgFn(bgFn);
			container.setPaddingX(this.ctx.outputPad ?? 1);
		}
		container.clear();
		const renderCall = this.renderers.renderCall;
		let call: Component | undefined;
		if (renderCall) {
			try {
				call = renderCall(this.tool.args, theme, this.renderContext(this.callRendererComponent));
				this.callRendererComponent = call;
			} catch {
				this.callRendererComponent = undefined;
			}
		}
		container.addChild(this.createResultRegion(call ?? this.createCallFallback()));
		hasContent = true;
		if (result) {
			const renderResult = this.renderers.renderResult;
			let component: Component | undefined;
			if (renderResult) {
				try {
					component = renderResult(
						result,
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.renderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = component;
				} catch {
					this.resultRendererComponent = undefined;
					component = this.createResultFallback(result);
				}
			} else component = this.createResultFallback(result);
			if (component) container.addChild(this.createResultRegion(component));
		}
		this.hideComponent = !hasContent;
	}
}
