import { Box, type Component, Container, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { ToolGroupDefinition, ToolGroupMember, ToolGroupRenderContext } from "../../../core/extensions/types.js";
import { theme } from "../theme/theme.js";

export class ToolGroupComponent extends Container {
	private definition: ToolGroupDefinition;
	private members: ToolGroupMember[] = [];
	private contentBox: Box;
	private ui: TUI;
	private closed = false;
	private disposed = false;
	private batchDepth = 0;
	private renderContext: ToolGroupRenderContext;
	private currentChild: Component | undefined;

	constructor(
		ui: TUI,
		definition: ToolGroupDefinition,
		options: { showImages?: boolean } = {},
		cwd: string = process.cwd(),
	) {
		super();
		this.ui = ui;
		this.definition = definition;

		this.addChild(new Spacer(1));

		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.addChild(this.contentBox);

		this.renderContext = {
			showImages: options.showImages ?? true,
			expanded: false,
			state: {},
			lastComponent: undefined,
			cwd,
			invalidate: () => {
				if (!this.disposed) {
					this.updateDisplay();
					this.ui.requestRender();
				}
			},
		};
	}

	addMember(toolCallId: string, toolName: string, args: unknown): void {
		if (this.closed) {
			console.warn(
				`ToolGroupComponent: cannot add member '${toolCallId}' to closed group '${this.definition.name}'`,
			);
			return;
		}
		this.members.push({
			toolCallId,
			toolName,
			args,
			argsComplete: false,
			executionStarted: false,
			result: undefined,
			isPartial: true,
		});
		this.updateDisplay();
	}

	updateMemberArgs(toolCallId: string, args: unknown): void {
		const member = this.findMember(toolCallId);
		if (member) {
			member.args = args;
			this.updateDisplay();
		}
	}

	markMemberExecutionStarted(toolCallId: string): void {
		const member = this.findMember(toolCallId);
		if (member) {
			member.executionStarted = true;
			this.updateDisplay();
		}
	}

	updateMemberResult(toolCallId: string, result: ToolGroupMember["result"], isPartial: boolean): void {
		const member = this.findMember(toolCallId);
		if (member) {
			member.result = result;
			member.isPartial = isPartial;
			if (!isPartial) {
				member.argsComplete = true;
			}
			this.updateDisplay();
		}
	}

	setMemberArgsComplete(toolCallId: string): void {
		const member = this.findMember(toolCallId);
		if (member && !member.argsComplete) {
			member.argsComplete = true;
			this.updateDisplay();
		}
	}

	populateMemberResult(toolCallId: string, result: ToolGroupMember["result"]): void {
		const member = this.findMember(toolCallId);
		if (member) {
			member.result = result;
			member.isPartial = false;
			member.argsComplete = true;
		}
	}

	batchUpdate(fn: () => void): void {
		this.batchDepth++;
		try {
			fn();
		} finally {
			this.batchDepth--;
			if (this.batchDepth === 0) {
				this.updateDisplay();
			}
		}
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		this.closed = true;
	}

	setExpanded(expanded: boolean): void {
		this.renderContext.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.renderContext.showImages = show;
		this.updateDisplay();
	}

	dispose(): void {
		this.disposed = true;
		if (this.currentChild && typeof (this.currentChild as any).dispose === "function") {
			(this.currentChild as any).dispose();
		}
		this.currentChild = undefined;
		this.members = [];
		this.renderContext.state = {};
		this.renderContext.lastComponent = undefined;
		this.definition = null!;
		this.ui = null!;
	}

	private findMember(toolCallId: string): ToolGroupMember | undefined {
		return this.members.find((m) => m.toolCallId === toolCallId);
	}

	private updateDisplay(): void {
		if (this.batchDepth > 0) {
			return;
		}

		if (this.members.length === 0) {
			return;
		}

		this.updateBackgroundColor();

		let component: Component | null | undefined;
		try {
			component = this.definition.render([...this.members], theme, this.renderContext);
		} catch (error) {
			console.error(`ToolGroupComponent: render() threw for group '${this.definition.name}':`, error);
			component = null;
		}

		if (!component) {
			const fallback = new Text(
				theme.fg("error", `[Group "${this.definition.name}" (${this.members.length} members): render error]`),
				0,
				0,
			);
			this.replaceChild(fallback);
			this.renderContext.lastComponent = undefined;
			return;
		}

		if (component === this.renderContext.lastComponent) {
			// Extension mutated the component in place, no need to swap children
		} else {
			this.replaceChild(component);
		}
		this.renderContext.lastComponent = component;
	}

	private replaceChild(component: Component): void {
		if (this.currentChild) {
			if (typeof (this.currentChild as any).dispose === "function") {
				(this.currentChild as any).dispose();
			}
			this.contentBox.removeChild(this.currentChild);
		}
		this.currentChild = component;
		this.contentBox.addChild(component);
	}

	private updateBackgroundColor(): void {
		const hasError = this.members.some((m) => m.result?.isError === true);
		const hasPending = this.members.length === 0 || this.members.some((m) => m.isPartial === true);

		let bgFn: (text: string) => string;
		if (hasError) {
			bgFn = (text: string) => theme.bg("toolErrorBg", text);
		} else if (hasPending) {
			bgFn = (text: string) => theme.bg("toolPendingBg", text);
		} else {
			bgFn = (text: string) => theme.bg("toolSuccessBg", text);
		}
		this.contentBox.setBgFn(bgFn);
	}
}
