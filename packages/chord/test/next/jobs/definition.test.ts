// Tests of job definitions (§15): what `defineJob` checks at declaration (names, versions, closed JSON args, a
// singleton state, concurrency, the shape of `accepts`, `persist` refused before slice 6) and the types it gives.

import { describe, expect, expectTypeOf, it } from "vitest";
import { bytes, int, map, obj, str, unknown } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { defineJob, type JobDefinition } from "../../../src/next/jobs/index.ts";

const Progress = defineState("app.progress", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
});

const Keyed = defineState("app.keyed", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
	keyed: true,
});

const args = obj({ command: str() });

describe("defineJob", () => {
	it("keeps its name, version, Chord's copies of its schemas, its state and concurrency", () => {
		const Shell = defineJob("app.shell", { version: 2, args, result: int(), state: Progress, concurrency: 1 });
		expect(Shell).toMatchObject({ name: "app.shell", version: 2, state: Progress, concurrency: 1, accepts: {} });
		expect(Shell.args.schema).not.toBe(args);
		expectTypeOf(Shell).toEqualTypeOf<JobDefinition<{ command: string }, number, { output: string }>>();
		const Plain = defineJob("app.plain", { version: 1, args, result: str() });
		expectTypeOf(Plain).toEqualTypeOf<JobDefinition<{ command: string }, string, undefined>>();
	});

	it('takes a restricted name only: lowercase [a-z0-9@/._~-] (decision "Restricted names")', () => {
		for (const name of ["@app/jobs.run_1~x-y", "a"])
			expect(defineJob(name, { version: 1, args, result: int() }).name).toBe(name);
		for (const name of ["", "App.run", "app:run", "app run", "a\0b", "a\uD800", "é"]) {
			expect(() => defineJob(name, { version: 1, args, result: int() })).toThrow(
				`A job name ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`,
			);
		}
		// Plugin code, not type-checked.
		expect(() => defineJob(42 as never, { version: 1, args, result: int() })).toThrow("A job name 42");
	});

	it("refuses a bad name, version, unknown option or concurrency", () => {
		expect(() => defineJob("", { version: 1, args, result: int() })).toThrow("A job name");
		expect(() => defineJob("j", { version: 0, args, result: int() })).toThrow(
			"j.version: expected a positive integer",
		);
		// Plugin code, not type-checked.
		const unknownKey = { version: 1, args, result: int(), retries: 3 } as never;
		expect(() => defineJob("j", unknownKey)).toThrow('j: unknown key "retries"');
		for (const concurrency of [0, 1.5, -1]) {
			expect(() => defineJob("j", { version: 1, args, result: int(), concurrency })).toThrow(
				"j.concurrency: expected a positive integer",
			);
		}
	});

	it("requires closed JSON args, as a method's: open objects and bytes are refused; records are fine", () => {
		const open = { type: "object", properties: { a: str() } } as never;
		expect(() => defineJob("j", { version: 1, args: open, result: int() })).toThrow(
			"argument objects must be closed",
		);
		expect(() => defineJob("j", { version: 1, args: obj({ data: bytes() }), result: int() })).toThrow(
			"j.args: job arguments are JSON",
		);
		expect(() => defineJob("j", { version: 1, args: obj({ tags: map(str()) }), result: unknown() })).not.toThrow();
	});

	it("takes a singleton document definition as its state", () => {
		expect(() => defineJob("j", { version: 1, args, result: int(), state: Keyed as never })).toThrow(
			"j.state: expected a singleton document definition",
		);
	});

	it("checks accepts at declaration: older versions only, each with an args and a result function", () => {
		const adapter = { args: (old: { cmd: string }) => ({ command: old.cmd }), result: (old: number) => old };
		expect(() =>
			defineJob("j", { version: 3, args, result: int(), accepts: { 1: adapter, 2: adapter } }),
		).not.toThrow();
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: { 2: adapter } })).toThrow(
			"j.accepts[2]: not an older version",
		);
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: { 0: adapter } })).toThrow(
			"j.accepts[0]: not an older version",
		);
		const noResult = { 1: { args: adapter.args } } as never;
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: noResult })).toThrow(
			"j.accepts[1].result: expected a function",
		);
		const extra = { 1: { ...adapter, state: () => null } } as never;
		expect(() => defineJob("j", { version: 2, args, result: int(), accepts: extra })).toThrow(
			'j.accepts[1]: unknown key "state"',
		);
	});

	it("takes persist with a resume rule, a persisted state and a JSON-only result (slice 6b §4)", () => {
		const Persisted = defineState("p.state", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => true,
		});
		const InMemory = defineState("m.state", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const job = defineJob("j", { version: 1, args, result: int(), state: Persisted, persist: { resume: "rerun" } });
		expect(job.persist).toEqual({ resume: "rerun" });
		expect(() =>
			defineJob("j", { version: 1, args, result: int(), state: InMemory, persist: { resume: "abandon" } }),
		).toThrow("a persisted job's state is a persisted document");
		expect(() => defineJob("j", { version: 1, args, result: bytes(), persist: { resume: "rerun" } })).toThrow(
			"a persisted job's result is JSON",
		);
		// An in-memory job may return bytes.
		expect(() => defineJob("j", { version: 1, args, result: bytes() })).not.toThrow();
		// @ts-expect-error: resume is required
		expect(() => defineJob("j", { version: 1, args, result: int(), persist: {} })).toThrow(
			'expected "rerun" or "abandon"',
		);
	});

	it("fingerprints args, result and state: a schema change without a version bump changes it", () => {
		const one = defineJob("j", { version: 1, args, result: int() });
		expect(defineJob("j", { version: 1, args, result: int() }).fingerprint).toBe(one.fingerprint);
		expect(defineJob("j", { version: 1, args, result: str() }).fingerprint).not.toBe(one.fingerprint);
	});
});
