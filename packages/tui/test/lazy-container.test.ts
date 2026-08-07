import assert from "node:assert";
import { describe, it } from "node:test";
import { LazyContainer } from "../src/components/lazy-container.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RenderCountingText extends Text {
	renderCount = 0;

	override render(width: number): string[] {
		this.renderCount += 1;
		return super.render(width);
	}
}

function makeMessages(count: number): RenderCountingText[] {
	return Array.from({ length: count }, (_, i) => {
		const t = new RenderCountingText("", 1, 0);
		t.setText(`message ${i} content line one\nline two\nline three`);
		return t;
	});
}

async function setup(messages: RenderCountingText[]) {
	const terminal = new VirtualTerminal(60, 20);
	const tui = new TuiAltScreen(terminal, false, "/tmp/tui-bench");
	const lazy = new LazyContainer({ batchSize: 3, preloadRows: 0 });
	const chat = new Container();
	for (const m of messages) chat.addChild(m);
	lazy.setBulkChild(chat);
	lazy.setMarkerLabel((n) => `--- ${n} earlier messages ---`);
	const scroll = new ScrollView(lazy, { follow: "end", primary: true, lazy: true });
	tui.setLayoutRoot(scroll);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, lazy, scroll, messages };
}

describe("LazyContainer", () => {
	it("parses only the visible window at startup, more on scroll-up", async () => {
		const messages = makeMessages(30);
		const { terminal, tui, messages: msgs } = await setup(messages);

		// Viewport is 20 rows; each message is 3 rows + marker spacing, so the
		// visible window parses ~6-7 messages, not all 30.
		const initiallyRendered = msgs.filter((m) => m.renderCount > 0).length;
		assert.ok(initiallyRendered >= 3 && initiallyRendered <= 10, `expected small window, got ${initiallyRendered}`);

		// The marker is present in the rendered content when older messages are
		// unparsed (it may sit above the viewport when following the end).
		const renderedAll = (await terminal.flushAndGetViewport()).join("\n");
		const fullOutput = (
			await (async () => {
				// Re-render the scroll content to inspect the marker row regardless of
				// the current scroll position.
				const lines = (tui as any).render(60) as string[];
				await terminal.flush();
				return lines;
			})()
		).join("\n");
		assert.ok(
			msgs.length > initiallyRendered && fullOutput.includes("earlier messages"),
			"marker should be rendered when content is deferred",
		);
		void renderedAll;

		// Scroll to top repeatedly; each arrival at the marker parses one batch.
		let lastRendered = initiallyRendered;
		for (let i = 0; i < 15; i++) {
			tui.scrollToTop();
			await new Promise((r) => setTimeout(r, 15));
			await terminal.flush();
			const rendered = msgs.filter((m) => m.renderCount > 0).length;
			assert.ok(rendered >= lastRendered, `render count shrank: ${rendered} < ${lastRendered}`);
			lastRendered = rendered;
			if (rendered === msgs.length) break;
		}
		assert.ok(
			msgs.every((m) => m.renderCount > 0),
			"all messages should eventually render",
		);
		tui.stop();
	});

	it("parses only the visible window in window mode (main screen)", async () => {
		const terminal = new VirtualTerminal(60, 20);
		const tui = new TuiAltScreen(terminal, false, "/tmp/tui-bench");
		const messages = makeMessages(30);
		const lazy = new LazyContainer({ batchSize: 3, preloadRows: 5 });
		const chat = new Container();
		for (const m of messages) chat.addChild(m);
		lazy.setBulkChild(chat);
		lazy.setWindowHeightProvider(() => 20); // terminal rows
		tui.addChild(lazy);
		tui.start();
		await terminal.waitForRender();
		const rendered = messages.filter((m) => m.renderCount > 0).length;
		assert.ok(rendered >= 3 && rendered <= 12, `expected small window, got ${rendered}`);
		// Window mode must not load more on its own (no scroll-up trigger).
		await new Promise((r) => setTimeout(r, 80));
		const after = messages.filter((m) => m.renderCount > 0).length;
		assert.ok(after <= 12, `window mode loaded more: ${after}`);
		tui.stop();
	});

	it("parses everything when disabled (full-history mode)", () => {
		const messages = makeMessages(5);
		const lazy = new LazyContainer();
		lazy.setEnabled(false);
		const chat = new Container();
		for (const m of messages) chat.addChild(m);
		lazy.setBulkChild(chat);
		const lines = lazy.render(40);
		assert.strictEqual(lines.length, 5 * 3, "all children render");
		assert.ok(messages.every((m) => m.renderCount > 0));
	});

	it("parses everything without a viewport (plain container usage)", () => {
		const messages = makeMessages(5);
		const lazy = new LazyContainer();
		const chat = new Container();
		for (const m of messages) chat.addChild(m);
		lazy.setBulkChild(chat);
		const lines = lazy.render(40);
		assert.strictEqual(lines.length, 5 * 3, "all children render");
		assert.ok(messages.every((m) => m.renderCount > 0));
	});
});
