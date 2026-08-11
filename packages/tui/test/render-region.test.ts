import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountingComponent implements Component {
	renderCount = 0;
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		this.renderCount += 1;
		return this.lines;
	}

	invalidate(): void {}
}

class ResetCountingTui extends TuiMainScreen {
	resetLineCount = 0;

	protected override applyLineResets(lines: string[]): string[] {
		this.resetLineCount += lines.length;
		return super.applyLineResets(lines);
	}
}

function createRenderRegion(kind: "stable" | "dynamic", children: readonly Component[]): Container {
	const region = new Container();
	for (const child of children) region.addChild(child);
	return region.setRenderRegion(kind);
}

describe("RenderRegion", () => {
	it("drops cached output when a region changes kind", () => {
		const content = new CountingComponent(["before"]);
		const region = createRenderRegion("stable", [content]);

		assert.deepStrictEqual(region.render(20), ["before"]);
		content.lines = ["after"];
		region.setRenderRegion("dynamic");

		assert.strictEqual(region.getCachedLineCount(20), undefined);
		assert.deepStrictEqual(region.render(20), ["after"]);
		assert.strictEqual(content.renderCount, 2);
	});

	it("preserves Container.clear array replacement for an empty region", () => {
		const region = new Container();
		const originalChildren = region.children;

		region.clear();

		assert.notStrictEqual(region.children, originalChildren);
	});

	it("keeps stable transcript work out of active main-screen renders", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new ResetCountingTui(terminal);
		const stableContent = new CountingComponent(
			Array.from({ length: 10_000 }, (_, index) => `stable transcript line ${index}`),
		);
		const stableRegion = createRenderRegion("stable", [stableContent]);
		const dynamicContent = new Text("working 0", 0, 0);

		tui.addChild(stableRegion);
		tui.addChild(dynamicContent);
		tui.start();
		await terminal.waitForRender();

		const stableRenderCount = stableContent.renderCount;
		const resetLineCount = tui.resetLineCount;
		dynamicContent.setText("working 1");
		tui.requestActiveRender();
		await terminal.waitForRender();

		assert.strictEqual(stableContent.renderCount, stableRenderCount);
		assert.ok(tui.resetLineCount - resetLineCount <= 1, "active render should reset only dynamic lines");
		tui.stop();
	});

	it("keeps parameterless requestRender conservative for stable content changes", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TuiMainScreen(terminal);
		const stableContent = new CountingComponent(["before"]);
		const stableRegion = createRenderRegion("stable", [stableContent]);

		tui.addChild(stableRegion);
		tui.start();
		await terminal.waitForRender();
		const renderCount = stableContent.renderCount;

		stableContent.lines = ["after"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(stableContent.renderCount, renderCount + 1);
		assert.match(terminal.getViewport().join("\n"), /after/);
		tui.stop();
	});

	it("does not let active requests downgrade a queued full invalidation", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TuiMainScreen(terminal);
		const stableContent = new CountingComponent(["before"]);
		tui.addChild(createRenderRegion("stable", [stableContent]));
		tui.start();
		await terminal.waitForRender();

		stableContent.lines = ["full then active"];
		tui.requestRender();
		tui.requestActiveRender();
		await terminal.waitForRender();
		assert.match(terminal.getViewport().join("\n"), /full then active/);

		stableContent.lines = ["active then full"];
		tui.requestActiveRender();
		tui.requestRender();
		await terminal.waitForRender();
		assert.match(terminal.getViewport().join("\n"), /active then full/);
		assert.strictEqual(stableContent.renderCount, 3);
		tui.stop();
	});

	it("preserves the viewport while active content appends", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new TuiMainScreen(terminal);
		const stableContent = new CountingComponent(Array.from({ length: 20 }, (_, index) => `stable ${index}`));
		const dynamicContent = new CountingComponent(["working"]);

		tui.addChild(createRenderRegion("stable", [stableContent]));
		tui.addChild(createRenderRegion("dynamic", [dynamicContent]));
		tui.start();
		await terminal.waitForRender();
		const redraws = tui.fullRedraws;

		dynamicContent.lines = ["working", "done"];
		tui.requestActiveRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redraws);
		assert.deepStrictEqual(terminal.getViewport(), ["stable 18", "stable 19", "working", "done"]);
		tui.stop();
	});

	it("falls back safely when active content shrinks", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new ResetCountingTui(terminal);
		const stableContent = new CountingComponent(Array.from({ length: 8 }, (_, index) => `stable ${index}`));
		const dynamicContent = new CountingComponent(["working", "done"]);

		tui.addChild(createRenderRegion("stable", [stableContent]));
		tui.addChild(createRenderRegion("dynamic", [dynamicContent]));
		tui.start();
		await terminal.waitForRender();
		const resetLineCount = tui.resetLineCount;

		dynamicContent.lines = ["done"];
		tui.requestActiveRender();
		await terminal.waitForRender();

		assert.ok(tui.resetLineCount - resetLineCount > stableContent.lines.length);
		assert.ok(terminal.getViewport().some((line) => line.includes("done")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("working")));
		tui.stop();
	});

	it("falls back safely for active Kitty images", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new ResetCountingTui(terminal);
		const stableContent = new CountingComponent(Array.from({ length: 8 }, (_, index) => `stable ${index}`));
		const dynamicContent = new CountingComponent(["working"]);
		const imageId = 931;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 2, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 2, widthPx: 100, heightPx: 100 });

		tui.addChild(createRenderRegion("stable", [stableContent]));
		tui.addChild(createRenderRegion("dynamic", [dynamicContent]));
		tui.start();
		await terminal.waitForRender();
		const resetLineCount = tui.resetLineCount;

		dynamicContent.lines = [imageLine, ""];
		tui.requestActiveRender();
		await terminal.waitForRender();

		assert.ok(tui.resetLineCount - resetLineCount > stableContent.lines.length);
		assert.ok(terminal.getViewport().every((line) => !line.includes("working")));
		tui.stop();
	});

	it("falls back safely while an overlay is visible", async () => {
		const terminal = new VirtualTerminal(24, 6);
		const tui = new ResetCountingTui(terminal);
		const stableContent = new CountingComponent(Array.from({ length: 8 }, (_, index) => `stable ${index}`));
		const dynamicContent = new Text("working 0", 0, 0);

		tui.addChild(createRenderRegion("stable", [stableContent]));
		tui.addChild(createRenderRegion("dynamic", [dynamicContent]));
		tui.start();
		await terminal.waitForRender();
		const overlay = tui.showOverlay(new Text("OVERLAY", 0, 0), { anchor: "top-left", width: 10 });
		await terminal.waitForRender();
		const resetLineCount = tui.resetLineCount;

		dynamicContent.setText("working 1");
		tui.requestActiveRender();
		await terminal.waitForRender();

		assert.ok(tui.resetLineCount - resetLineCount > stableContent.lines.length);
		assert.ok(terminal.getViewport().some((line) => line.includes("OVERLAY")));
		assert.ok(terminal.getViewport().some((line) => line.includes("working 1")));
		overlay.hide();
		tui.stop();
	});

	it("promotes dynamic children without redrawing unchanged transcript content", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new TuiMainScreen(terminal);
		const stableContainer = new Container();
		const dynamicContainer = new Container();
		const stableRegion = createRenderRegion("stable", [stableContainer]);
		const dynamicRegion = createRenderRegion("dynamic", [dynamicContainer]);
		const stableLine = new Text("stable", 0, 0);
		const dynamicLine = new Text("dynamic", 0, 0);
		stableContainer.addChild(stableLine);
		dynamicContainer.addChild(dynamicLine);

		tui.addChild(stableRegion);
		tui.addChild(dynamicRegion);
		tui.start();
		await terminal.waitForRender();
		const redraws = tui.fullRedraws;
		const viewport = terminal.getViewport();

		stableContainer.addChild(dynamicLine);
		dynamicContainer.removeChild(dynamicLine);
		stableRegion.expireRenderRegion();
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redraws);
		assert.deepStrictEqual(terminal.getViewport(), viewport);
		tui.stop();
	});

	it("reuses stable region output in fullscreen layout frames", () => {
		const stableContent = new CountingComponent(
			Array.from({ length: 10_000 }, (_, index) => `stable transcript line ${index}`),
		);
		const stableRegion = createRenderRegion("stable", [stableContent]);
		const dynamicContent = new Text("working 0", 0, 0);
		const document = new VStack([stableRegion, dynamicContent]);
		const viewport = new ScrollView(document, { follow: "end" });

		renderLayoutFrame(viewport, 40, 8, () => {});
		const stableRenderCount = stableContent.renderCount;
		dynamicContent.setText("working 1");
		renderLayoutFrame(viewport, 40, 8, () => {});

		assert.strictEqual(stableContent.renderCount, stableRenderCount);
	});

	it("invalidates stable region output on fullscreen full renders", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new TuiAltScreen(terminal);
		const stableContent = new CountingComponent(["before"]);
		const stableRegion = createRenderRegion("stable", [stableContent]);
		const document = new VStack([stableRegion, new Text("dynamic", 0, 0)]);
		tui.setLayoutRoot(new ScrollView(document, { follow: "end" }));
		tui.start();
		await terminal.waitForRender();
		const renderCount = stableContent.renderCount;

		stableContent.lines = ["after"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(stableContent.renderCount, renderCount + 1);
		assert.ok(terminal.getViewport().some((line) => line.includes("after")));
		tui.stop();
	});
});
