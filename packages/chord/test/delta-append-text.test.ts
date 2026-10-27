import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { appendText, applyImmutable, type Draft, type Op, type StringKeys, track } from "../src/delta/index.ts";

// #9265: streaming writers appended to growing strings by assignment, and the tracker's prefix check copied the whole
// string on every change.

type Block = { type: "text"; text: string; signature?: string; tags: string[] };
type Doc = { title: string; content: Block[]; meta: { note: string } };

function doc(): Doc {
	return { title: "t", content: [{ type: "text", text: "hello", tags: ["a"] }], meta: { note: "n" } };
}

/** Run `mutate` in one change, adopt it, and return its ops; checks that replaying the ops gives the new value. */
function commit<T extends object>(tracker: ReturnType<typeof track<T>>, mutate: (draft: Draft<T>) => void): Op[] {
	const base = tracker.value;
	const change = tracker.beginChange();
	mutate(change.state);
	const prepared = change.prepare();
	expect(applyImmutable(base, prepared.ops)).toEqual(prepared.value);
	tracker.adopt(prepared);
	return [...prepared.ops];
}

describe("appendText", () => {
	it("records an append op and the appended value", () => {
		const tracker = track(doc());
		const before = tracker.value;
		expect(commit(tracker, (draft) => appendText(draft.content[0]!, "text", " world"))).toEqual([
			["a", ["content", 0, "text"], " world"],
		]);
		expect(tracker.value.content[0]!.text).toBe("hello world");
		expect(before.content[0]!.text).toBe("hello");
		expect(commit(tracker, (draft) => appendText(draft, "title", "!"))).toEqual([["a", ["title"], "!"]]);
		expect(commit(tracker, (draft) => appendText(draft.meta, "note", "ote"))).toEqual([
			["a", ["meta", "note"], "ote"],
		]);
		expect(tracker.value).toEqual({
			title: "t!",
			content: [{ type: "text", text: "hello world", tags: ["a"] }],
			meta: { note: "note" },
		});
	});

	it("joins several appends to one key in one change into one op, next to other changes", () => {
		const tracker = track(doc());
		const ops = commit(tracker, (draft) => {
			appendText(draft.content[0]!, "text", " a");
			draft.title = "new";
			appendText(draft.content[0]!, "text", " b");
			appendText(draft.content[0]!, "text", "");
			appendText(draft.content[0]!, "text", " c");
		});
		expect(ops).toContainEqual(["a", ["content", 0, "text"], " a b c"]);
		expect(ops).toContainEqual(["s", ["title"], "new"]);
		expect(ops).toHaveLength(2);
		expect(tracker.value.content[0]!.text).toBe("hello a b c");
	});

	it("falls back to the string comparison when the same key is also assigned or deleted", () => {
		const tracker = track(doc());
		expect(
			commit(tracker, (draft) => {
				appendText(draft.content[0]!, "text", " x");
				draft.content[0]!.text += " y";
			}),
		).toEqual([["a", ["content", 0, "text"], " x y"]]);
		expect(
			commit(tracker, (draft) => {
				appendText(draft.content[0]!, "text", " z");
				draft.content[0]!.text = "replaced";
			}),
		).toEqual([["s", ["content", 0, "text"], "replaced"]]);
		expect(
			commit(tracker, (draft) => {
				draft.title = "assigned";
				appendText(draft, "title", " then appended");
			}),
		).toEqual([["s", ["title"], "assigned then appended"]]);
		expect(
			commit(tracker, (draft) => {
				appendText(draft.meta, "note", "x");
				delete (draft.meta as { note?: string }).note;
			}),
		).toEqual([["d", ["meta", "note"]]]);
	});

	it("appends inside a block the same change inserted or replaced", () => {
		const tracker = track(doc());
		commit(tracker, (draft) => {
			draft.content.push({ type: "text", text: "new", tags: [] });
			appendText(draft.content[1]!, "text", " block");
			draft.content[0] = { type: "text", text: "other", tags: [] };
			appendText(draft.content[0]!, "text", " one");
		});
		expect(tracker.value.content.map((block) => block.text)).toEqual(["other one", "new block"]);
	});

	it("rejects what a JavaScript caller can get wrong", () => {
		const tracker = track(doc());
		const append = appendText as (draft: unknown, key: string, text: string) => void;
		expect(() => append({ text: "plain object" }, "text", "x")).toThrow("appendText() needs a draft");
		const change = tracker.beginChange();
		expect(() => append(change.state, "content", "x")).toThrow('appendText() needs a string at "content"');
		expect(() => append(change.state, "missing", "x")).toThrow('appendText() needs a string at "missing"');
		expect(() => append(change.state.content, "0", "x")).toThrow('appendText() needs a string at "0"');
		const block = change.state.content[0]!;
		change.prepare();
		expect(() => appendText(block, "text", "x")).toThrow("Cannot use a settled overlay");
		const aborted = tracker.beginChange();
		const state = aborted.state;
		aborted.abort();
		expect(() => appendText(state, "title", "x")).toThrow("Cannot use a settled overlay");
	});

	it("accepts only keys whose type is exactly string", () => {
		type Keys = StringKeys<Block>;
		const keys: Keys[] = ["text"];
		expect(keys).toEqual(["text"]);
		const tracker = track(doc());
		const change = tracker.beginChange();
		const block = change.state.content[0]!;
		// @ts-expect-error a string literal type
		expect(() => appendText(block, "type", "x")).not.toThrow();
		// @ts-expect-error an optional string
		expect(() => appendText(block, "signature", "x")).toThrow();
		// @ts-expect-error an array
		expect(() => appendText(block, "tags", "x")).toThrow();
		// @ts-expect-error array keys
		expect(() => appendText(change.state.content, 0, "x")).toThrow();
		change.abort();
	});

	it("keeps an op text that does not hold a larger string it was cut from alive", () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		gc();
		const before = getHeapStatistics().used_heap_size;
		const tracker = track(doc());
		const ops: Op[] = [];
		for (let index = 0; index < 50; index++) {
			const source = `${index}`.repeat(100_000);
			ops.push(...commit(tracker, (draft) => appendText(draft.content[0]!, "text", source.slice(0, 40))));
		}
		gc();
		expect(getHeapStatistics().used_heap_size - before).toBeLessThan(1_000_000);
		expect(ops).toHaveLength(50);
	});
});

describe("appendText cost", () => {
	/** Bytes `run` allocates, counting what collections during it freed. */
	function allocatedBytes(run: () => void): number {
		const profiler = new GCProfiler();
		profiler.start();
		const before = getHeapStatistics().used_heap_size;
		run();
		const after = getHeapStatistics().used_heap_size;
		let freed = 0;
		for (const collection of profiler.stop().statistics) {
			freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
		}
		return after - before + freed;
	}

	/** One change per 40-character chunk, appended to one streamed text until it has `length` characters. */
	function stream(length: number): number {
		const tracker = track(doc());
		const chunk = "0123456789abcdefghij0123456789abcdefghij";
		return allocatedBytes(() => {
			for (let streamed = 0; streamed < length; streamed += chunk.length) {
				const change = tracker.beginChange();
				appendText(change.state.content[0]!, "text", chunk);
				tracker.adopt(change.prepare());
			}
		});
	}

	it("costs O(chunk) per change: a 500 KB stream allocates linearly", () => {
		const small = stream(50_000);
		const large = stream(500_000);
		// Ten times the text: linear growth is about 10x. Measured about 10 KB per change, mostly the change itself.
		expect(large / small).toBeLessThan(20);
		expect(large / 12_500).toBeLessThan(40_000);
		// The same stream through `draft.text += chunk` makes prepare() compare the whole string on every change: on
		// Node 24, 6 GB allocated and about 2 s for 500 KB, against 120 MB and under 0.1 s here. Not asserted.
	});
});
