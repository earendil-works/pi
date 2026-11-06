import { describe, expect, it } from "vitest";
import { insertSessionByActivity } from "../src/core/session-manager.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";

describe("progressive session sorting", () => {
	it("maintains descending activity order with stable ties regardless of arrival", () => {
		const sorted: SessionInfo[] = [];
		const make = (id: string, timestamp: number) =>
			({ id, modified: new Date(timestamp) }) as SessionInfo;
		for (const entry of [
			make("old", 10),
			make("new", 30),
			make("same-a", 20),
			make("same-b", 20),
		]) {
			insertSessionByActivity(sorted, entry);
		}
		expect(sorted.map((s) => s.id)).toEqual(["new", "same-a", "same-b", "old"]);
	});
	it("sorts a large stream of completions without repeated full-array sorting", () => {
		const sorted: SessionInfo[] = [];
		for (let index = 0; index < 10_000; index++) {
			insertSessionByActivity(sorted, { id: String(index), modified: new Date(index % 53) } as SessionInfo);
		}
		expect(sorted).toHaveLength(10_000);
		for (let index = 1; index < sorted.length; index++) {
			expect(sorted[index - 1]!.modified.getTime()).toBeGreaterThanOrEqual(sorted[index]!.modified.getTime());
		}
	});
});
