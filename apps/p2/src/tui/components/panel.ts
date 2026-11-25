// The side panel's frame: a title line over a scrollable body, both behind a one-column bar that separates the panel
// from the chat on its left. The runtime lays it out next to the screen's body and routes keys to it while focused.
import { type Component, ScrollView, truncateToWidth, VStack } from "@earendil-works/pi-tui";
import type { RenderContext } from "../render-context.ts";

/** What a plugin shows in the panel: lines at a width, released when the panel closes. */
export type PanelContent = Component & { dispose?(): void };

export class PanelFrame {
	readonly id: string;
	readonly content: PanelContent;
	readonly scroll: ScrollView;
	/** The component the runtime lays out (title over the scroll view). */
	readonly root: VStack;
	focused = false;

	constructor(
		ctx: RenderContext & { hints: { key(id: string, description: string): string } },
		id: string,
		content: PanelContent,
		title: () => string,
	) {
		this.id = id;
		this.content = content;
		const bar = (focused: boolean) => ctx.theme.current.fg(focused ? "accent" : "border", "│");
		const frame = this;
		// The bar must reach the bottom of the panel even when the content is shorter than the viewport.
		const body: Component = {
			render(width) {
				const inner = Math.max(1, width - 2);
				const lines = content.render(inner);
				const height = Math.max(lines.length, frame.scroll.viewportHeight);
				const prefix = `${bar(frame.focused)} `;
				return Array.from({ length: height }, (_, row) => prefix + (lines[row] ?? ""));
			},
			invalidate: () => content.invalidate(),
		};
		this.scroll = new ScrollView(body, {
			overscroll: "contain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => ctx.theme.current.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => ctx.theme.current.fg("scrollbarThumb", text),
		});
		const header: Component = {
			render(width) {
				const theme = ctx.theme.current;
				const hint = frame.focused
					? `  ${ctx.hints.key("tui.select.cancel", "back")}`
					: `  ${ctx.hints.key("p2.panel.focus", "focus")}`;
				return [truncateToWidth(`${bar(frame.focused)} ${theme.bold(title())}${hint}`, width)];
			},
			invalidate() {},
		};
		this.root = new VStack([
			{ component: header, basis: 1, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
	}
}
