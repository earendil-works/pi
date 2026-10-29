// Tests of one run's record (§15): its `running` entry per phase, and its handle's wait for the outcome.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { JobRun } from "../../../src/next/jobs/run.ts";
import { rejection } from "../support.ts";

describe("a run", () => {
	it("has an entry per phase: args and state while running or finishing, neither when blocked, with its reason", () => {
		const run = new JobRun("r1", 2, "k", { command: "ls" }, "running");
		expect(run.entryFor({ output: "" })).toEqual({
			id: "r1",
			version: 2,
			key: "k",
			args: { command: "ls" },
			state: { output: "" },
			phase: "running",
		});
		run.phase = "finishing";
		expect(new JobRun("r2", 1, undefined, { a: 1 }, "running").entryFor(undefined)).toEqual({
			id: "r2",
			version: 1,
			args: { a: 1 },
			phase: "running",
		});
		run.phase = "blocked";
		run.blocked = "finish_failed";
		expect(run.entryFor({ output: "x" })).toEqual({
			id: "r1",
			version: 2,
			phase: "blocked",
			reason: "finish_failed",
		});
		run.blocked = "version";
		expect(run.entryFor(undefined)).toMatchObject({ phase: "blocked", reason: "version" });
		// A persisted run waiting for its reservation, or stopped, runs (again): `running`.
		run.phase = "pending";
		expect(run.entryFor(undefined)).toMatchObject({ phase: "running" });
		run.phase = "stopped";
		expect(run.entryFor(undefined)).toMatchObject({ phase: "running" });
	});

	it("gives every waiter the outcome, late ones too; a waiter's context ends only its wait", async () => {
		const run = new JobRun("r1", 1, undefined, {}, "running");
		const { context: waiting, cancel } = withCancel(context);
		const cancelled = rejection(run.handle.outcome(waiting));
		cancel(new Error("left"));
		expect(await cancelled).toMatchObject({ message: "left" });
		const outcome = { id: "r1", args: {}, state: undefined, kind: "done", result: 1 } as const;
		run.resolve(outcome);
		expect(await run.handle.outcome(context)).toBe(outcome);
		const rejected = new JobRun("r2", 1, undefined, {}, "running");
		rejected.reject(new ChordError({ code: "aborted", message: "dropped" }));
		expect(await rejection(rejected.handle.outcome(context))).toMatchObject({ code: "aborted" });
	});
});
