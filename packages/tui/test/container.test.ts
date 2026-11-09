import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { Container, type TuiMouseEvent } from "../src/tui.ts";

function wheelAt(y: number, width: number, height: number): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: 1,
	};
}

// #9549: copying every transcript line on every frame made long fullscreen transcripts expensive.
describe("container output reuse", () => {
	it("returns the same lines while children are unchanged", () => {
		const text = new Text("hello", 0, 0);
		const inner = new Container();
		inner.addChild(text);
		inner.addChild(new Spacer(1));
		const outer = new Container();
		outer.addChild(inner);

		const first = outer.render(20);
		assert.strictEqual(outer.render(20), first);

		text.setText("changed");
		const changed = outer.render(20);
		assert.notStrictEqual(changed, first);
		assert.deepStrictEqual(
			changed.map((line) => line.trimEnd()),
			["changed", ""],
		);
		assert.deepStrictEqual(
			first.map((line) => line.trimEnd()),
			["hello", ""],
		);
	});

	it("re-renders when children are added or the width changes", () => {
		const container = new Container();
		container.addChild(new Text("a", 0, 0));
		const first = container.render(20);
		container.addChild(new Text("b", 0, 0));
		assert.deepStrictEqual(
			container.render(20).map((line) => line.trimEnd()),
			["a", "b"],
		);
		assert.notStrictEqual(container.render(10), first);
	});

	it("reuses box output while its children are unchanged", () => {
		const text = new Text("boxed", 0, 0);
		const box = new Box(1, 0);
		box.addChild(text);
		const first = box.render(20);
		assert.strictEqual(box.render(20), first);
		text.setText("next");
		assert.notStrictEqual(box.render(20), first);
	});

	it("dispatches mouse events by the rendered child heights", () => {
		const hits: string[] = [];
		const target = (name: string, lines: number) => ({
			render: () => Array.from({ length: lines }, () => name),
			invalidate: () => {},
			handleMouse: () => {
				hits.push(name);
				return { handled: true };
			},
		});
		const container = new Container();
		container.addChild(target("first", 2));
		container.addChild(target("second", 1));
		container.render(20);
		container.handleMouse(wheelAt(2, 20, 3));
		container.handleMouse(wheelAt(1, 20, 3));
		assert.deepStrictEqual(hits, ["second", "first"]);
	});
});
