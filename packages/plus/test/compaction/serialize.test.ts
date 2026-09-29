/**
 * Tests for plus/src/compaction/serialize.ts — the manual-compaction queue.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAsyncSerializer } from "../../src/compaction/serialize.ts";

describe("createAsyncSerializer", () => {
	it("runs calls one at a time, in order", async () => {
		const serialize = createAsyncSerializer();
		const events: string[] = [];
		const make = (name: string, ms: number) => () =>
			new Promise<string>((resolve) => {
				events.push(`${name}:start`);
				setTimeout(() => {
					events.push(`${name}:end`);
					resolve(name);
				}, ms);
			});

		const first = serialize(make("first", 30));
		const second = serialize(make("second", 10));
		const results = await Promise.all([first, second]);

		assert.deepEqual(results, ["first", "second"]);
		assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
	});

	it("continues the queue after a rejection", async () => {
		const serialize = createAsyncSerializer();
		const events: string[] = [];
		const failing = serialize(async () => {
			events.push("failing:start");
			throw new Error("boom");
		});
		const next = serialize(async () => {
			events.push("next:start");
			return "ok";
		});

		await assert.rejects(failing, /boom/);
		assert.equal(await next, "ok");
		assert.deepEqual(events, ["failing:start", "next:start"]);
	});

	it("does not share state between instances", async () => {
		const a = createAsyncSerializer();
		const b = createAsyncSerializer();
		const events: string[] = [];
		await Promise.all([
			a(async () => {
				await new Promise((r) => setTimeout(r, 20));
				events.push("a");
			}),
			b(async () => {
				events.push("b");
			}),
		]);
		assert.deepEqual(events, ["b", "a"]);
	});
});
