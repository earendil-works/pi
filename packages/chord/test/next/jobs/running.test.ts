// Tests of `running`'s list (§15): each change copies the list, keeps the other entries identical and gives the ops
// of exactly that change (a state change re-pathed under its entry); one frame per batch; derives over it are marked.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { applyImmutable, type Op } from "../../../src/delta/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import { Running } from "../../../src/next/jobs/running.ts";
import { Batch, Derive } from "../../../src/next/state/internal.ts";
import { delivered, framesOf } from "../support.ts";

function running() {
	const batch = new Batch(() => {}, undefined);
	return { batch, list: new Running(batch, "app.store job app.echo") };
}

describe("running's list", () => {
	it("copies the list per change, keeps other entries identical, and frames apply to the previous value", async () => {
		const { batch, list } = running();
		const a = { id: "a", phase: "running", state: { output: "" } };
		const b = { id: "b", phase: "running", state: { output: "" } };
		const watch = await list.watch(context);
		const frames = framesOf(watch);
		let previous = list.value;
		batch.commit(() => {
			list.add(a);
			list.add(b);
		}, context);
		await delivered();
		const added = list.value as JsonValue[];
		expect(added).toEqual([a, b]);
		expect(added).not.toBe(previous);
		const b2 = { ...b, state: { output: "x" } };
		batch.commit(() => list.stateChanged(b, b2, [["a", ["output"], "x"]]), context);
		await delivered();
		const a2 = { ...a, phase: "finishing" };
		batch.commit(() => list.replace(a, a2), context);
		await delivered();
		batch.commit(() => list.remove(a2), context);
		await delivered();
		expect(list.value).toEqual([b2]);
		expect((list.value as JsonValue[])[0]).toBe(b2);
		expect(frames.map(([, ops]) => ops)).toEqual([
			[
				["p", [], 0, 0, [a]],
				["p", [], 1, 0, [b]],
			],
			[["a", [1, "state", "output"], "x"]],
			[["s", [0], a2]],
			[["p", [], 0, 1, []]],
		] satisfies Op[][]);
		// Every frame turns the previous value into the next.
		previous = [];
		for (const [value, ops] of frames) {
			expect(applyImmutable(previous, ops)).toEqual(value);
			previous = value;
		}
	});

	it("re-paths every kind of state op under its entry; a replacement becomes a set", async () => {
		const { batch, list } = running();
		const entry = { id: "a", state: { list: [1], text: "", n: 0 } };
		batch.commit(() => list.add(entry), context);
		const frames = framesOf(await list.watch(context));
		const after = { id: "a", state: { list: [2], text: "t", n: 1 } };
		const ops: Op[] = [
			["r", { list: [], text: "", n: 0 }],
			["s", ["n"], 1],
			["p", ["list"], 0, 0, [2]],
			["a", ["text"], "t"],
			["d", ["gone"]],
			["t", ["text"], 1],
			["m", ["list"], [0]],
		];
		batch.commit(() => list.stateChanged(entry, after, ops), context);
		await delivered();
		expect(frames[0]![1]).toEqual([
			["s", [0, "state"], { list: [], text: "", n: 0 }],
			["s", [0, "state", "n"], 1],
			["p", [0, "state", "list"], 0, 0, [2]],
			["a", [0, "state", "text"], "t"],
			["d", [0, "state", "gone"]],
			["t", [0, "state", "text"], 1],
			["m", [0, "state", "list"], [0]],
		]);
	});

	it("builds no op for a state change while unwatched (cost guard: the ops are not even walked)", () => {
		const { batch, list } = running();
		const entry = { id: "a", state: { output: "" } };
		batch.commit(() => list.add(entry), context);
		const unwalked = {
			[Symbol.iterator]: () => {
				throw new Error("walked");
			},
		} as unknown as Op[];
		const after = { id: "a", state: { output: "x" } };
		batch.commit(() => list.stateChanged(entry, after, unwalked), context);
		expect(list.value).toEqual([after]);
	});

	it("keeps nothing once ended: reads throw released", async () => {
		const { batch, list } = running();
		batch.commit(() => list.add({ id: "a" }), context);
		const watch = await list.watch(context);
		list.end();
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => list.value).toThrow("app.store job app.echo: ended");
	});

	it("records no ops while unwatched, and marks derives over it at every change", () => {
		const { batch, list } = running();
		const count = new Derive([list], ([value]) => (value as JsonValue[]).length, batch);
		count.attach(
			(source) => source as Running,
			() => {},
		);
		expect(count.value).toBe(0);
		batch.commit(() => list.add({ id: "a" }), context);
		expect(count.value).toBe(1);
		batch.commit(() => list.add({ id: "b" }), context);
		expect(count.value).toBe(2);
	});
});
