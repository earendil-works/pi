import {
	type Component,
	ScrollView,
	Text,
	TRANSCRIPT_BLOCK,
	TRANSCRIPT_SEMANTICS,
	type TranscriptTarget,
	VStack,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import {
	type TranscriptBlockDefinition,
	TranscriptContainer,
	TranscriptDocument,
} from "../src/modes/interactive/transcript-document.ts";

class SemanticText extends Text {
	private readonly target: TranscriptTarget;

	constructor(text: string, target: TranscriptTarget) {
		super(text, 0, 0);
		this.target = target;
	}

	[TRANSCRIPT_BLOCK](): TranscriptTarget {
		return this.target;
	}
}

function createDocument(requestRender: () => void = () => {}) {
	const header = new TranscriptContainer();
	const resources = new TranscriptContainer();
	const live = new TranscriptContainer();
	const document = new TranscriptDocument({ header, resources, live, requestRender });
	return { document, header, resources, live };
}

function definition(id: string, text: string, target?: TranscriptTarget): TranscriptBlockDefinition {
	return {
		id,
		...(target ? { target } : {}),
		create: () => new Text(text, 0, 0),
	};
}

function visible(lines: readonly string[]): string[] {
	return lines.map((line) => line.trimEnd());
}

describe("TranscriptDocument", () => {
	it("matches full eager output while rendering an exact fullscreen window", () => {
		const { document, header, resources, live } = createDocument();
		header.addChild(new Text("header", 0, 0));
		resources.addChild(new Text("resource", 0, 0));
		document.setHistory([
			definition("one", "one\none-b"),
			definition("two", "two"),
			definition("three", "three\nthree-b"),
		]);
		live.addChild(new Text("live", 0, 0));
		const eager = visible(document.render(20));
		expect(eager).toEqual(["header", "resource", "one", "one-b", "two", "three", "three-b", "live"]);

		const scroll = new ScrollView(document, { follow: "end" });
		const frame = renderLayoutFrame(new VStack([{ component: scroll, basis: 0, grow: 1 }]), 20, 3, () => {});
		expect(visible(frame.lines)).toEqual(eager.slice(-3));
		expect(frame.root.children[0]?.children[0]?.lines?.length).toBe(3);
	});

	it("hydrates exact heights once, then renders only newly visited blocks", () => {
		const { document } = createDocument();
		let created = 0;
		const history = Array.from(
			{ length: 10_000 },
			(_, index): TranscriptBlockDefinition => ({
				id: `block:${index}`,
				create: () => {
					created += 1;
					return new Text(`row ${index}`, 0, 0);
				},
			}),
		);
		document.setHistory(history);
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 20, 5, () => {});

		expect(visible(render().lines)).toEqual(["row 9995", "row 9996", "row 9997", "row 9998", "row 9999"]);
		expect(created).toBe(10_000);
		render();
		expect(created).toBe(10_000);

		scroll.scrollToStart();
		expect(visible(render().lines)).toEqual(["row 0", "row 1", "row 2", "row 3", "row 4"]);
		expect(created).toBeLessThanOrEqual(10_005);
		render();
		expect(created).toBeLessThanOrEqual(10_005);
	});

	it("remeasures exact heights and discards stale rendered lines after a width change", () => {
		const { document } = createDocument();
		document.setHistory([definition("wrapped", "abcdefghij")]);
		const scroll = new ScrollView(document, { follow: "end" });
		const wide = renderLayoutFrame(scroll, 20, 5, () => {});
		expect(wide.root.scrollContent?.height).toBe(1);
		const narrow = renderLayoutFrame(scroll, 4, 5, () => {});
		expect(narrow.root.scrollContent?.height).toBe(3);
		expect(visible(narrow.lines).slice(0, 3)).toEqual(["abcd", "efgh", "ij"]);
	});

	it("preserves the top semantic row when an earlier live block changes height", () => {
		const { document, header } = createDocument();
		const mutableHeader = new Text("header", 0, 0);
		header.addChild(mutableHeader);
		document.setHistory(Array.from({ length: 10 }, (_, index) => definition(`row:${index}`, `row ${index}`)));
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 20, 3, () => {});
		render();
		scroll.scrollTo(4, { disableFollow: true });
		expect(visible(render().lines)).toEqual(["row 3", "row 4", "row 5"]);

		mutableHeader.setText("header\nheader 2\nheader 3");
		header.markDirty(mutableHeader);
		expect(visible(render().lines)).toEqual(["row 3", "row 4", "row 5"]);
		expect(scroll.scrollTop).toBe(6);
	});

	it("isolates renderer failures and keeps the remaining transcript usable", () => {
		const { document } = createDocument();
		const broken: TranscriptBlockDefinition = {
			id: "broken",
			create: (): Component => ({
				invalidate: () => {},
				render: () => {
					throw new Error("boom");
				},
			}),
		};
		document.setHistory([definition("before", "before"), broken, definition("after", "after")]);
		const lines = visible(document.render(80));
		expect(lines[0]).toBe("before");
		expect(lines[1]).toContain("broken failed to render: boom");
		expect(lines[2]).toBe("after");
	});

	it("retains history component trees only for regular terminal-owned scrollback", () => {
		const { document, live } = createDocument();
		let created = 0;
		document.setHistory(
			Array.from({ length: 3_000 }, (_, index) => ({
				id: `regular:${index}`,
				create: () => {
					created += 1;
					return new Text(`row ${index}`, 0, 0);
				},
			})),
		);
		document.setEagerMode(true);
		document.render(80);
		expect(created).toBe(3_000);
		live.addChild(new Text("new tail", 0, 0));
		document.render(80);
		expect(created).toBe(3_000);
		document.setEagerMode(false);
	});

	it("reconciles an appended canonical suffix without revisiting prior history", () => {
		const { document, live } = createDocument();
		const prior = Array.from({ length: 10_000 }, (_, index) => ({
			id: `prior:${index}`,
			component: new SemanticText(`prior ${index}`, { id: `target:${index}`, kind: "assistant" as const }),
		}));
		document.setHistory(prior.map(({ id, component }) => ({ id, create: () => component })));
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 30, 3, () => {});
		render();
		const provisional = new Text("provisional", 0, 0);
		live.addChild(provisional);
		render();
		const appended = definition("canonical", "canonical");
		expect(document.appendHistoryAndClearLive([appended])).toBe(true);
		expect(visible(render().lines)).toEqual(["prior 9998", "prior 9999", "canonical"]);
	});

	it("slices and reuses one oversized block for steady viewport frames", () => {
		const { document } = createDocument();
		let renders = 0;
		const lines = Array.from({ length: 100_000 }, (_, row) => `row ${row}`);
		document.setHistory([
			{
				id: "giant",
				create: () => ({
					invalidate: () => {},
					render: () => {
						renders += 1;
						return lines;
					},
				}),
			},
		]);
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 30, 25, () => {});
		const first = render();
		expect(first.root.children[0]?.lines?.length).toBe(25);
		expect(renders).toBe(1);
		for (let frame = 0; frame < 10; frame++) render();
		expect(renders).toBe(1);
	});

	it("keeps several large visible image blocks in one bounded aggregate cache", () => {
		const { document } = createDocument();
		const renders = [0, 0, 0, 0];
		const sizes = [1_000_000, 500_000, 250_000, 150_000];
		document.setHistory(
			sizes.map((size, index) => ({
				id: `image:${index}`,
				create: () => ({
					invalidate: () => {},
					render: () => {
						renders[index] = (renders[index] ?? 0) + 1;
						return [`\x1b]1337;File=inline=1:${"A".repeat(size)}\x07`];
					},
				}),
			})),
		);
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 20, 4, () => {});
		render();
		renders.fill(0);
		render();
		expect(renders).toEqual([0, 0, 0, 0]);
	});

	it("rerenders visible persistent extension components without freezing opaque state", () => {
		const { document } = createDocument();
		let renders = 0;
		document.setHistory([
			{
				id: "dynamic",
				persistent: true,
				create: () => ({
					invalidate: () => {},
					render: () => [`render ${++renders}`],
				}),
			},
		]);
		const scroll = new ScrollView(document);
		expect(visible(renderLayoutFrame(scroll, 20, 1, () => {}).lines)).toEqual(["render 2"]);
		expect(visible(renderLayoutFrame(scroll, 20, 1, () => {}).lines)).toEqual(["render 3"]);
	});

	it("provides stable semantic lookup without mounting unrelated history", () => {
		const { document, live } = createDocument();
		const user: TranscriptTarget = { id: "entry:user", kind: "user", metadata: { text: "question" } };
		const assistant: TranscriptTarget = {
			id: "entry:assistant",
			kind: "assistant",
			metadata: { text: "answer" },
		};
		document.setHistory([
			definition("user", "question", user),
			definition("assistant", "answer\ncontinued", assistant),
		]);
		live.addChild(new SemanticText("tool", { id: "live:tool", kind: "tool" }));
		const scroll = new ScrollView(document, { follow: "end", primary: true });
		const frame = renderLayoutFrame(scroll, 40, 2, () => {});
		const semantics = document[TRANSCRIPT_SEMANTICS]();
		expect(visible(frame.lines)).toEqual(["continued", "tool"]);
		expect(semantics.blockAt(1)?.target).toEqual(assistant);
		expect(semantics.latestResponse()?.target).toEqual(assistant);
		expect(semantics.find(user)?.startRow).toBe(0);
		expect(semantics.blocks(0, 4).map((block) => block.target.id)).toEqual([
			"entry:user",
			"entry:assistant",
			"live:tool",
		]);
	});
});
