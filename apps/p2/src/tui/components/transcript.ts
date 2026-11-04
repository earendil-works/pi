// The chat transcript as incremental components, as coding-agent's DurableTui (experimental/durable/tui.ts
// `#syncTranscript`/`#addEntry`/`#syncStreaming`) does it, but keyed by the shared display model's items
// (src/web/transcript.ts): an unchanged item keeps its component, a changed one updates it in place (a streaming answer
// becomes its committed entry under the same key), and a gone one is disposed. It also keeps the reading position: when
// not following the end, the item at the top of the viewport stays put while older history is prepended or items above
// it change height (p2-tui-port.md P0c).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type Component, Container, type ScrollView, Spacer } from "@earendil-works/pi-tui";
import type { EntryRenderContext, TuiEntryRenderer } from "../../runtime/tui-renderers.ts";
import type { Item, ToolView, Transcript } from "../../web/transcript.ts";
import type { ToolRenderers } from "../tools/types.ts";
import {
	AssistantMessageComponent,
	CompactionSummaryComponent,
	type MessageContext,
	NoticeComponent,
	UserMessageComponent,
} from "./messages.ts";
import { type ToolCardContext, ToolExecutionComponent } from "./tool-execution.ts";

export type TranscriptContext = MessageContext &
	ToolCardContext & {
		toolRenderers(name: string): ToolRenderers | undefined;
		readonly entryRenderers: ReadonlyMap<string, TuiEntryRenderer>;
	};

/** Where the reader is: an item and the line offset within it at the top of the viewport. */
export type TranscriptAnchor = { key: string; entryId?: number; offset: number };

type ViewState = { expanded: boolean; showThinking: boolean };
type EntryItem = { type: "entry"; key: string; entryId: number; entry: EntryRecord };
type ViewItem = Item | EntryItem;

interface ItemView {
	readonly component: Component;
	item: ViewItem;
	update(item: ViewItem): boolean;
	setState(state: ViewState): void;
	dispose(): void;
}

/** The entry ID an item shows, also for failures and markers keyed by their entry. */
export function itemEntryId(item: ViewItem): number | undefined {
	if ("entryId" in item && item.entryId !== undefined) return item.entryId;
	const match = /^(\d+)(?:-|$)/.exec(item.key);
	return match ? Number(match[1]) : undefined;
}

/** Calls of a streaming answer as pending cards (DTUI `#syncStreaming`). */
function streamingTools(message: AssistantMessage): ToolView[] {
	return message.content.flatMap((part) =>
		part.type === "toolCall"
			? [{ id: part.id, name: part.name, args: part.arguments, status: "pending" as const, output: "", images: [] }]
			: [],
	);
}

class AssistantView implements ItemView {
	readonly component = new Container();
	item: Extract<Item, { type: "assistant" }>;
	private message: AssistantMessageComponent;
	private cards = new Map<string, ToolExecutionComponent>();
	private ctx: TranscriptContext;
	private state: ViewState;
	constructor(item: Extract<Item, { type: "assistant" }>, ctx: TranscriptContext, state: ViewState) {
		this.item = item;
		this.ctx = ctx;
		this.state = state;
		this.message = new AssistantMessageComponent(ctx, undefined, !state.showThinking);
		this.component.addChild(this.message);
		this.sync();
	}
	update(item: ViewItem): boolean {
		if (item.type !== "assistant") return false;
		if (item === this.item) return true;
		this.item = item;
		this.sync();
		return true;
	}
	private sync(): void {
		const item = this.item;
		this.message.updateContent(item.message, item.streaming);
		const tools = item.streaming ? streamingTools(item.message) : item.tools;
		const next = new Map<string, ToolExecutionComponent>();
		for (const tool of tools) {
			let card = this.cards.get(tool.id);
			if (card && card.toolId === tool.id) card.update(tool, !item.streaming);
			else {
				card = new ToolExecutionComponent(tool, this.ctx.toolRenderers(tool.name), this.ctx, !item.streaming);
				card.setExpanded(this.state.expanded);
			}
			next.set(tool.id, card);
		}
		for (const [id, card] of this.cards) if (!next.has(id)) card.dispose();
		this.cards = next;
		this.component.children.length = 0;
		this.component.addChild(this.message);
		for (const card of next.values()) this.component.addChild(card);
		this.component.invalidate();
	}
	setState(state: ViewState): void {
		this.state = state;
		this.message.setHideThinkingBlock(!state.showThinking);
		for (const card of this.cards.values()) card.setExpanded(state.expanded);
	}
	dispose(): void {
		for (const card of this.cards.values()) card.dispose();
	}
}

class ToolItemView implements ItemView {
	readonly component: ToolExecutionComponent;
	item: Extract<Item, { type: "tool" }>;
	constructor(item: Extract<Item, { type: "tool" }>, ctx: TranscriptContext, state: ViewState) {
		this.item = item;
		this.component = new ToolExecutionComponent(item.tool, ctx.toolRenderers(item.tool.name), ctx);
		this.component.setExpanded(state.expanded);
	}
	update(item: ViewItem): boolean {
		if (item.type !== "tool" || item.tool.id !== this.item.tool.id) return false;
		this.item = item;
		this.component.update(item.tool);
		return true;
	}
	setState(state: ViewState): void {
		this.component.setExpanded(state.expanded);
	}
	dispose(): void {
		this.component.dispose();
	}
}

class UserView implements ItemView {
	readonly component: Container;
	item: Extract<Item, { type: "user" }>;
	private message: UserMessageComponent;
	constructor(item: Extract<Item, { type: "user" }>, ctx: TranscriptContext) {
		this.item = item;
		this.message = new UserMessageComponent(item, ctx);
		this.component = new Container();
		this.component.addChild(new Spacer(1));
		this.component.addChild(this.message);
	}
	update(item: ViewItem): boolean {
		if (item.type !== "user") return false;
		this.item = item;
		this.message.update(item);
		return true;
	}
	/** A skill block follows the tools toggle, as pi's (Ctrl+O). */
	setState(state: ViewState): void {
		this.message.setExpanded(state.expanded);
	}
	dispose(): void {}
}

class NoticeView implements ItemView {
	readonly component: NoticeComponent;
	item: Extract<Item, { type: "failure" }>;
	constructor(item: Extract<Item, { type: "failure" }>, ctx: TranscriptContext) {
		this.item = item;
		this.component = new NoticeComponent(item.text, "error", ctx);
	}
	update(item: ViewItem): boolean {
		if (item.type !== "failure") return false;
		this.item = item;
		this.component.update(item.text);
		return true;
	}
	setState(): void {}
	dispose(): void {}
}

/** A gap: entries between two loaded ones are missing; they load while the line is in view (`onVisibleGap`). */
class GapView implements ItemView {
	readonly component: NoticeComponent;
	item: Extract<Item, { type: "gap" }>;
	constructor(item: Extract<Item, { type: "gap" }>, ctx: TranscriptContext) {
		this.item = item;
		this.component = new NoticeComponent(gapText(item), "muted", ctx);
	}
	update(item: ViewItem): boolean {
		if (item.type !== "gap") return false;
		this.item = item;
		this.component.update(gapText(item));
		return true;
	}
	setState(): void {}
	dispose(): void {}
}

const gapText = (item: Extract<Item, { type: "gap" }>): string => (item.loading ? "Loading…" : "Load more");

class MarkerView implements ItemView {
	readonly component: Container = new Container();
	item: Extract<Item, { type: "marker" }>;
	private summary: CompactionSummaryComponent | undefined;
	private ctx: TranscriptContext;
	private state: ViewState;
	constructor(item: Extract<Item, { type: "marker" }>, ctx: TranscriptContext, state: ViewState) {
		this.item = item;
		this.ctx = ctx;
		this.state = state;
		this.build();
	}
	private build(): void {
		this.component.clear();
		this.summary = undefined;
		if (this.item.label === "Context compacted") {
			this.summary = new CompactionSummaryComponent(this.item.detail ?? "", this.state.expanded, this.ctx);
			this.component.addChild(new Spacer(1));
			this.component.addChild(this.summary);
		} else if (this.item.label === "New context" && this.item.detail?.trim()) {
			// A handoff's text belongs to its new-context marker, expandable like a compaction summary.
			this.summary = new CompactionSummaryComponent(this.item.detail, this.state.expanded, this.ctx, {
				label: "[new context]",
				collapsed: "Handoff note",
			});
			this.component.addChild(new Spacer(1));
			this.component.addChild(this.summary);
		} else
			this.component.addChild(
				new NoticeComponent(
					this.item.label === "New context" ? "[new context]" : `[${this.item.label}]`,
					"muted",
					this.ctx,
				),
			);
	}
	update(item: ViewItem): boolean {
		if (item.type !== "marker") return false;
		this.item = item;
		this.build();
		return true;
	}
	setState(state: ViewState): void {
		this.state = state;
		this.summary?.setExpanded(state.expanded);
	}
	dispose(): void {}
}

/** A plugin's component for an entry kind (`TuiEntryRenderers`); rebuilt when its entry or renderer changes. */
class EntryView implements ItemView {
	readonly component = new Container();
	item: EntryItem;
	private renderer: TuiEntryRenderer;
	private ctx: TranscriptContext;
	private state: ViewState;
	constructor(item: EntryItem, renderer: TuiEntryRenderer, ctx: TranscriptContext, state: ViewState) {
		this.item = item;
		this.renderer = renderer;
		this.ctx = ctx;
		this.state = state;
		this.build();
	}
	private build(): void {
		this.component.clear();
		const context: EntryRenderContext = { ...this.ctx, expanded: this.state.expanded };
		try {
			const component = this.renderer(this.item.entry, context);
			if (component) this.component.addChild(component);
		} catch {
			this.component.addChild(
				new NoticeComponent(`[${this.item.entry.kind}: renderer failed]`, "warning", this.ctx),
			);
		}
	}
	update(item: ViewItem): boolean {
		if (item.type !== "entry" || this.ctx.entryRenderers.get(item.entry.kind) !== this.renderer) return false;
		if (item.entry === this.item.entry) return true;
		this.item = item;
		this.build();
		return true;
	}
	setState(state: ViewState): void {
		if (state.expanded === this.state.expanded) return;
		this.state = state;
		this.build();
	}
	dispose(): void {}
}

function createView(item: ViewItem, ctx: TranscriptContext, state: ViewState): ItemView {
	switch (item.type) {
		case "assistant":
			return new AssistantView(item, ctx, state);
		case "tool":
			return new ToolItemView(item, ctx, state);
		case "user":
			return new UserView(item, ctx);
		case "failure":
			return new NoticeView(item, ctx);
		case "gap":
			return new GapView(item, ctx);
		case "marker":
			return new MarkerView(item, ctx, state);
		case "entry":
			return new EntryView(item, ctx.entryRenderers.get(item.entry.kind)!, ctx, state);
	}
}

/** Items in order, with entries of kinds a plugin renders in place of what the transcript made of them. */
function viewItems(
	items: readonly Item[],
	retained: readonly EntryRecord[],
	renderers: ReadonlyMap<string, unknown>,
): ViewItem[] {
	if (renderers.size === 0) return [...items];
	const custom = retained.filter((entry) => renderers.has(entry.kind));
	if (custom.length === 0) return [...items];
	const replaced = new Set<number>(custom.map((entry) => entry.id));
	const result: ViewItem[] = [];
	let next = 0;
	const flush = (below: number) => {
		while (next < custom.length && custom[next]!.id < below) {
			const entry = custom[next++]!;
			result.push({ type: "entry", key: `entry-${entry.id}`, entryId: entry.id, entry });
		}
	};
	for (const item of items) {
		const id = itemEntryId(item);
		flush(id ?? Number.POSITIVE_INFINITY);
		if (id === undefined || !replaced.has(id)) result.push(item);
	}
	flush(Number.POSITIVE_INFINITY);
	return result;
}

export class TranscriptView implements Component {
	private ctx: TranscriptContext;
	private header: Component | undefined;
	private views = new Map<string, ItemView>();
	private order: ItemView[] = [];
	private keys: string[] = [];
	private state: ViewState;
	private scroll: ScrollView | undefined;
	/** Items of the last render with their first line, in order. */
	private rendered: { key: string; start: number; entryId?: number }[] = [];
	private pendingAnchor: TranscriptAnchor | undefined;
	/** Called when the reader reached the top: load older history. */
	onTop: (() => void) | undefined;
	/** Called for each gap shown in the viewport: load its entries. */
	onVisibleGap: ((item: Extract<Item, { type: "gap" }>) => void) | undefined;
	/** A restored anchor is not loaded yet: older pages may hold it. */
	onMissingAnchor: ((anchor: TranscriptAnchor) => boolean) | undefined;
	empty = "";
	/** Shown after the items: live content that is no entry yet (a running user shell command). */
	tail: Component | undefined;

	constructor(ctx: TranscriptContext, state: ViewState, header?: Component) {
		this.ctx = ctx;
		this.state = state;
		this.header = header;
	}

	/** The scroll view showing this transcript; needed to keep the reading position. */
	attach(scroll: ScrollView): void {
		this.scroll = scroll;
	}

	sync(transcript: Transcript | undefined, retained: readonly EntryRecord[] = []): void {
		const items = transcript ? viewItems(transcript.items, retained, this.ctx.entryRenderers) : [];
		const next = new Map<string, ItemView>();
		const order: ItemView[] = [];
		for (const item of items) {
			let view = this.views.get(item.key);
			if (view && next.has(item.key)) view = undefined;
			if (view && view.item !== item && !view.update(item)) {
				view.dispose();
				view = undefined;
			}
			view ??= createView(item, this.ctx, this.state);
			next.set(item.key, view);
			order.push(view);
		}
		for (const [key, view] of this.views) if (next.get(key) !== view) view.dispose();
		this.views = next;
		this.order = order;
		this.keys = items.map((item) => item.key);
	}

	/** Drops every component, e.g. when renderers changed; the next sync recreates them. */
	reset(): void {
		for (const view of this.order) view.dispose();
		this.views.clear();
		this.order = [];
		this.keys = [];
	}

	setState(state: Partial<ViewState>): void {
		const next = { ...this.state, ...state };
		if (next.expanded === this.state.expanded && next.showThinking === this.state.showThinking) return;
		this.state = next;
		for (const view of this.order) view.setState(next);
	}

	/** The reading position, or undefined while following the end. */
	anchor(): TranscriptAnchor | undefined {
		const scroll = this.scroll;
		if (!scroll || scroll.isFollowingEnd) return undefined;
		return this.anchorAt(scroll.scrollTop);
	}

	/** Restore a reading position (after a reload or conversation switch) once its item is loaded. */
	restore(anchor: TranscriptAnchor | undefined): void {
		this.pendingAnchor = anchor;
		if (!anchor) this.scroll?.scrollToEnd();
	}

	/** The item at line `top` in the last render; above the first item (the header), the first one with a negative offset. */
	private anchorAt(top: number): TranscriptAnchor | undefined {
		let best: TranscriptAnchor | undefined;
		for (const [index, item] of this.rendered.entries()) {
			if (item.start > top && index > 0) break;
			best = {
				key: item.key,
				offset: top - item.start,
				...(item.entryId === undefined ? {} : { entryId: item.entryId }),
			};
		}
		return best;
	}

	invalidate(): void {
		this.header?.invalidate();
		for (const view of this.order) view.component.invalidate();
		this.tail?.invalidate();
	}

	render(width: number): string[] {
		const scroll = this.scroll;
		// The item at the top of the viewport before this render, measured with the previous offsets.
		const kept =
			this.pendingAnchor ?? (scroll && !scroll.isFollowingEnd ? this.anchorAt(scroll.scrollTop) : undefined);
		const lines: string[] = this.header ? [...this.header.render(width)] : [];
		const starts = new Map<string, number>();
		const rendered: { key: string; start: number; entryId?: number }[] = [];
		this.order.forEach((view, index) => {
			const key = this.keys[index]!;
			starts.set(key, lines.length);
			rendered.push({ key, start: lines.length, entryId: itemEntryId(view.item) });
			lines.push(...view.component.render(width));
		});
		if (this.order.length === 0 && this.empty && !this.tail) lines.push("", ` ${this.empty}`);
		if (this.tail) lines.push(...this.tail.render(width));
		// One empty line between the transcript and the dock (DTUI).
		lines.push("");
		this.rendered = rendered;
		if (scroll && kept) {
			const start = starts.get(kept.key);
			if (start !== undefined) {
				const top = Math.max(0, start + kept.offset);
				if (this.pendingAnchor || top !== scroll.scrollTop) {
					// The layout clamps against the last content height: give it this one first.
					scroll.updateLayout(lines.length, scroll.viewportHeight, () => this.ctx.requestRender());
					scroll.scrollTo(top, { disableFollow: true });
				}
				this.pendingAnchor = undefined;
			} else if (this.pendingAnchor ?? (kept.entryId !== undefined ? kept : undefined)) {
				// The anchored entry is gone, e.g. a reconnect's fresh snapshot dropped older pages: page back to it.
				const restoring = this.pendingAnchor !== undefined;
				this.pendingAnchor ??= kept;
				if (!this.onMissingAnchor?.(this.pendingAnchor)) {
					// Not in older history either: a restore follows the end, a vanished item keeps the position.
					this.pendingAnchor = undefined;
					if (restoring) scroll.scrollToEnd();
				}
			}
		}
		// At the top of a laid-out viewport (or everything fits): older history may continue above.
		if (scroll && scroll.viewportHeight > 0 && scroll.scrollTop === 0 && !this.pendingAnchor) this.onTop?.();
		if (scroll && scroll.viewportHeight > 0 && !this.pendingAnchor)
			this.order.forEach((view, index) => {
				const start = rendered[index]!.start;
				const end = rendered[index + 1]?.start ?? lines.length;
				const visible = end > scroll.scrollTop && start < scroll.scrollTop + scroll.viewportHeight;
				if (visible && view.item.type === "gap") this.onVisibleGap?.(view.item);
			});
		return lines;
	}

	dispose(): void {
		for (const view of this.order) view.dispose();
		this.views.clear();
		this.order = [];
	}
}
