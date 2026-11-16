// Tests of `openReaders` (slice 14 §3.2), the step a parked attempt or an admission opens its readers of named
// queries with: ready once each has a value; parked on the first that has none, saying why (the cause a reload's
// report waits for); broken for the reader's own code. The declarations' checks and builders are tested through
// live queries and lists (`query-reader.test.ts`, `named-query.test.ts`, `list.test.ts`).

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import type { Blocker } from "../../src/host/dependencies.ts";
import type { Opened, Reader } from "../../src/host/query-reader.ts";
import { openReaders } from "../../src/host/read-declarations.ts";
import type { Dependent } from "../../src/state/internal.ts";

/** A reader that opens as `opened`, and the dependents of its source. */
function reader(opened: Opened): { readonly reader: Reader; readonly dependents: Set<Dependent> } {
	const dependents = new Set<Dependent>();
	// `openReaders` opens a reader and follows its source, nothing else.
	return { reader: { open: async () => opened, source: { dependents } } as unknown as Reader, dependents };
}

/** Opens `readers` with a wake and a record of the blockers named. */
async function opening(...readers: ReturnType<typeof reader>[]) {
	const wake: Dependent = { invalidate: () => {}, sourceRetired: () => {} };
	const blockers: (Blocker | undefined)[] = [];
	const long = { blockedBy: (blocker: Blocker | undefined) => void blockers.push(blocker) };
	const list = readers.map((each) => each.reader);
	return { parking: await openReaders(list, wake, long, "app.doc: a live query", context), wake, blockers };
}

describe("opening readers", () => {
	it("is ready once every reader has a value, and follows none", async () => {
		const [a, b] = [reader({ kind: "ready" }), reader({ kind: "ready" })];
		const { parking } = await opening(a, b);
		expect(parking).toEqual({ kind: "ready" });
		expect([a.dependents.size, b.dependents.size]).toEqual([0, 0]);
	});

	it("parks waiting on a read that failed, with the cause a reload's report names, and follows it", async () => {
		const failed = reader({ kind: "waiting", error: new Error("no such set") });
		const later = reader({ kind: "ready" });
		const { parking, wake, blockers } = await opening(failed, later);
		expect(parking).toMatchObject({
			kind: "parked",
			firstPass: true,
			shown: { kind: "failed", cause: { kind: "waiting" } },
			cause: {
				kind: "waiting",
				error: { message: "waiting for app.doc: a live query: app.doc: a live query: no such set" },
			},
		});
		expect([failed.dependents.has(wake), later.dependents.size]).toEqual([true, 0]);
		expect(blockers.at(-1)).toEqual({ label: "app.doc: a live query", state: "failed" });
	});

	it("parks loading on a read that has not run yet, with a cause too, and holds up the first pass", async () => {
		const pending = reader({ kind: "loading" });
		const { parking, wake } = await opening(reader({ kind: "ready" }), pending);
		expect(parking).toMatchObject({
			kind: "parked",
			firstPass: false,
			shown: { kind: "loading" },
			cause: {
				kind: "waiting",
				error: { message: "waiting for app.doc: a live query: app.doc: a live query is loading" },
			},
		});
		expect(pending.dependents.has(wake)).toBe(true);
	});

	it("breaks on a reader's own code", async () => {
		const { parking } = await opening(reader({ kind: "broken", error: new Error("bad arguments") }));
		expect(parking).toMatchObject({ kind: "broken", error: { message: "app.doc: a live query: bad arguments" } });
	});
});
