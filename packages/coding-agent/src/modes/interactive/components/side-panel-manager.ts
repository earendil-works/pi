import type { Component, OverlayHandle, OverlayOptions, TUI } from "@mariozechner/pi-tui";
import { Container, Text } from "@mariozechner/pi-tui";
import type { ExtensionSidePanelOptions } from "../../../core/extensions/types.js";
import type { Theme } from "../theme/theme.js";

function resolveOverlayOptions(
	component: Component,
	options?: ExtensionSidePanelOptions,
): OverlayOptions {
	const width = options?.width ?? ((component as { width?: number }).width ?? "28%");
	return {
		width,
		minWidth: options?.minWidth ?? 24,
		maxHeight: options?.maxHeight ?? "75%",
		anchor: options?.anchor ?? "right-center",
		margin: options?.margin ?? 1,
		offsetX: options?.offsetX,
		offsetY: options?.offsetY,
		nonCapturing: true,
		visible: options?.visibleMinWidth
			? (termWidth) => termWidth >= options.visibleMinWidth!
			: undefined,
	};
}

export class SidePanelManager {
	private component: (Component & { dispose?(): void }) | undefined;
	private handle: OverlayHandle | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {}

	set(
		content:
			| string[]
			| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
			| undefined,
		options?: ExtensionSidePanelOptions,
	): void {
		this.clear();
		if (content === undefined) {
			return;
		}
		const component = Array.isArray(content) ? this.wrapLines(content) : content(this.tui, this.theme);
		this.component = component;
		this.handle = this.tui.showOverlay(component, resolveOverlayOptions(component, options));
	}

	clear(): void {
		this.handle?.hide();
		this.handle = undefined;
		this.component?.dispose?.();
		this.component = undefined;
	}

	dispose(): void {
		this.clear();
	}

	private wrapLines(lines: string[]): Container {
		const container = new Container();
		for (const line of lines) {
			container.addChild(new Text(line, 1, 0));
		}
		return container;
	}
}

export { resolveOverlayOptions };
