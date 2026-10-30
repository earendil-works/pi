import { describe, expect, it } from "vitest";
import type { StoredSpan } from "../src/index.ts";
import { renderTrace } from "../src/render.ts";

function span(id: string, overrides: Partial<StoredSpan> = {}): StoredSpan {
	return {
		id,
		traceId: "trace",
		name: id,
		startedMs: 0,
		endedMs: 10,
		attributes: {},
		events: [],
		links: [],
		status: { status: "ok" },
		...overrides,
	};
}

describe("renderTrace", () => {
	it("renders an unordered trace with attributes, durations, errors, events, and links", () => {
		const root = span("root", {
			startedMs: 1000,
			endedMs: 1020,
			attributes: {
				request: "a b",
				attempt: 2,
				cached: false,
				tags: ["a", "b"],
				sizes: [1, 2],
				flags: [true, false],
			},
			events: [
				{ name: "checkpoint", timeMs: 2, attributes: { phase: "tools" } },
				{ name: "tick", timeMs: 3.5, attributes: {} },
			],
			links: [
				{ traceId: "remote-trace", spanId: "remote", attributes: { reason: "steer" } },
				{ traceId: "other-trace", spanId: "other" },
			],
		});
		const first = span("first", {
			parentId: "root",
			startedMs: 1005,
			endedMs: 1009.5,
			status: { status: "error", error: { name: "Error", message: "failed call" } },
		});
		const nested = span("nested", { parentId: "first", startedMs: 1006, endedMs: 1007 });
		const second = span("second", {
			parentId: "root",
			startedMs: 1010,
			endedMs: 1012,
			status: { status: "error" },
		});
		const spans = Object.freeze([second, nested, first, root]);
		const before = structuredClone(spans);
		expect(renderTrace(spans)).toBe(
			[
				'root request="a b" attempt=2 cached=false tags=["a","b"] sizes=[1,2] flags=[true,false] (20ms)',
				'  · checkpoint phase="tools" (+2ms)',
				"  · tick (+3.5ms)",
				'  → link trace remote-trace span remote reason="steer"',
				"  → link trace other-trace span other",
				"  first (4.5ms) error Error: failed call",
				"    nested (1ms)",
				"  second (2ms) error",
			].join("\n"),
		);
		expect(spans).toEqual(before);
	});

	it("treats missing parents as roots and orders roots and children by start time", () => {
		expect(
			renderTrace([
				span("later", { parentId: "external", startedMs: 20, endedMs: 30 }),
				span("child", { parentId: "later", startedMs: 25, endedMs: 30 }),
				span("earlier", { startedMs: 10, endedMs: 15, links: [{ traceId: "trace", spanId: "later" }] }),
			]),
		).toBe(["earlier (5ms)", "  → link trace trace span later", "later (10ms)", "  child (5ms)"].join("\n"));
	});

	it("prints cross-trace links without following them, including cycles", () => {
		expect(
			renderTrace([
				span("server:1", {
					name: "server",
					traceId: "server-trace",
					links: [{ traceId: "worker-trace", spanId: "worker:1" }],
				}),
				span("worker:1", {
					name: "worker",
					traceId: "worker-trace",
					links: [{ traceId: "server-trace", spanId: "server:1" }],
				}),
			]),
		).toBe(
			[
				"server (10ms)",
				"  → link trace worker-trace span worker:1",
				"worker (10ms)",
				"  → link trace server-trace span server:1",
			].join("\n"),
		);
	});

	it("deduplicates spans merged from stores by global ID", () => {
		const root = span("server:1", { name: "root" });
		const child = span("worker:1", {
			name: "child",
			parentId: "server:1",
			events: [{ name: "done", timeMs: 3, attributes: {} }],
		});
		const grandchild = span("worker:2", { name: "grandchild", parentId: "worker:1" });
		expect(renderTrace([child, root, grandchild, structuredClone(root), structuredClone(child)])).toBe(
			"root (10ms)\n  child (10ms)\n    · done (+3ms)\n    grandchild (10ms)",
		);
	});

	it("preserves input order for equal start times without mutating the input", () => {
		const spans = Object.freeze([
			span("root"),
			span("z", { parentId: "root" }),
			span("a", { parentId: "root" }),
			span("other"),
		]);
		expect(renderTrace(spans)).toBe("root (10ms)\n  z (10ms)\n  a (10ms)\nother (10ms)");
	});

	it("escapes string attribute values without hiding their contents", () => {
		expect(renderTrace([span("root", { attributes: { text: 'line one\n"line two"' } })])).toBe(
			'root text="line one\\n\\"line two\\"" (10ms)',
		);
	});

	it("renders deep trees without recursive calls", () => {
		const spans = Array.from({ length: 2000 }, (_, index) =>
			span(String(index), index === 0 ? {} : { parentId: String(index - 1) }),
		);
		const rendered = renderTrace(spans);
		expect(rendered.split("\n")).toHaveLength(spans.length);
		expect(rendered.endsWith(`${"  ".repeat(1999)}1999 (10ms)`)).toBe(true);
	});

	it("renders an empty input as an empty string", () => {
		expect(renderTrace([])).toBe("");
	});
});
