// The viewer's clock correction: a page's spans moved by the least amount that puts the server's spans under them
// inside them; nothing moved when they fit, or when no server span is under a page span.
// Run from packages/chord:
//   node ../../node_modules/vitest/dist/cli.js --run test/examples/61-tutorial/plugins/traces/clock.test.ts
import type { StoredSpan } from "@todo/app/v1/server";
import { describe, expect, it } from "vitest";
import { clamped } from "./clock.ts";

/** A span `id` on `host` from `startedMs` to `endedMs`, under `parentId`. */
function span(id: string, host: string, startedMs: number, endedMs: number, parentId?: string): StoredSpan {
	return {
		id,
		traceId: "t",
		...(parentId === undefined ? {} : { parentId }),
		name: id,
		startedMs,
		endedMs,
		attributes: { "chord.host": host },
		events: [],
		links: [],
		status: { status: "ok" },
	};
}

/** Each span's times after the correction. */
function times(spans: readonly StoredSpan[]): [string, number, number][] {
	return clamped(spans).map(({ id, startedMs, endedMs }) => [id, startedMs, endedMs]);
}

describe("clamped", () => {
	it("moves a page that runs late back, so its call contains the server's relay", () => {
		const spans = [span("click", "browser", 5000, 5010), span("call", "browser", 5001, 5009, "click")];
		spans.push(span("relay", "server", 2002, 2008, "call"));
		expect(times(spans)).toEqual([
			["click", 2001, 2011],
			["call", 2002, 2010],
			["relay", 2002, 2008],
		]);
	});

	it("moves a page that runs early forward by the least amount", () => {
		const spans = [span("call", "browser", 100, 110), span("relay", "server", 1101, 1105, "call")];
		expect(times(spans)).toEqual([
			["call", 1095, 1105],
			["relay", 1101, 1105],
		]);
	});

	it("moves nothing when the server's spans fit, or when no server span is under a page span", () => {
		const fitting = [span("call", "browser", 100, 110), span("relay", "server", 101, 109, "call")];
		expect(clamped(fitting)).toBe(fitting);
		const alone = [span("click", "browser", 5000, 5010), span("other", "server", 1, 2)];
		expect(clamped(alone)).toBe(alone);
	});

	it("centres a server child longer than its page parent", () => {
		const spans = [span("call", "browser", 100, 102), span("relay", "server", 200, 210, "call")];
		expect(times(spans)[0]).toEqual(["call", 204, 206]);
	});
});
