// Residency (slice 6a §10, rule 23): Durable's idle structure, one timer per object, the granule rule, eviction on
// the line oldest first.

import { describe, expect, it, vi } from "vitest";
import { track } from "../../../src/delta/index.ts";
import { RETENTION_MS, Residency, Resident } from "../../../src/next/documents/residency.ts";
import { fakeTimers, flushed } from "../support.ts";

/** A residency whose sweeps run at once (no line), and the keys it evicted, in order. */
function idle() {
	const evicted: string[] = [];
	const slot = { evict: (resident: Resident) => void evicted.push(resident.key) };

	const residency = new Residency((sweep) => {
		sweep();
	});
	const resident = (key: string) => new Resident(slot, key, track({}), undefined, 1);
	return { residency, resident, evicted };
}

describe("the idle structure", () => {
	fakeTimers();

	it("evict idle documents oldest first once their retention passed, with one timer", async () => {
		const { residency, resident, evicted } = idle();
		const a = resident("a");
		const b = resident("b");
		residency.touch(a);
		vi.advanceTimersByTime(5_000);
		residency.touch(b);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(RETENTION_MS - 5_000);
		await flushed();
		expect(evicted).toEqual(["a"]);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(5_000);
		expect(evicted).toEqual(["a", "b"]);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(RETENTION_MS);
		expect(evicted).toEqual(["a", "b"]);
	});

	it("move a touched document to the back at most once per granule", () => {
		const { residency, resident, evicted } = idle();
		const a = resident("a");
		const b = resident("b");
		residency.touch(a);
		residency.touch(b);
		vi.advanceTimersByTime(500);
		residency.touch(a);
		vi.advanceTimersByTime(RETENTION_MS - 500);
		// Within its granule the touch did not move `a`: it leaves up to a granule early.
		expect(evicted).toEqual(["a", "b"]);
		residency.touch(a);
		residency.touch(b);
		vi.advanceTimersByTime(1_000);
		residency.touch(a);
		vi.advanceTimersByTime(RETENTION_MS - 1_000);
		expect(evicted).toEqual(["a", "b", "b"]);
		vi.advanceTimersByTime(1_000);
		expect(evicted).toEqual(["a", "b", "b", "a"]);
	});

	it("forget pinned documents; after end nothing is evicted and no timer is left", () => {
		const { residency, resident, evicted } = idle();
		const a = resident("a");
		residency.touch(a);
		residency.forget(a);
		vi.advanceTimersByTime(RETENTION_MS);
		expect(evicted).toEqual([]);
		residency.touch(resident("b"));
		residency.end();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(RETENTION_MS);
		expect(evicted).toEqual([]);
	});
});
