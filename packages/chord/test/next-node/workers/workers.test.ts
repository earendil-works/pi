// Tests of the workers component (slice 10 §3, §4): starts on demand (the link made at the fork, `started` on
// `connect`, the start timer covering only the start), failures that stay (a crash, a `fatal`, a lost link, a failed
// start: no fork for a new hold, holders `failed { waiting }`) until `retry` or a rollout, idle stops and `busy`, `stop`
// and its suspension, the per-address queue, `close`, the rollout step, and nothing kept of 1,000 addresses.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withAbortSignal } from "../../../src/context/index.ts";
import { createHost } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import type { RolloutHost } from "../../../src/next-node/plugins/index.ts";
import { expectCollected } from "../../next/support.ts";
import { Control } from "../fixtures/workers/control.ts";
import { context, fleet, Notes, Session, type TestPrincipal, until } from "./support.ts";

/** A step's hosts as `[host, what]`. */
function listed(hosts: readonly RolloutHost[]) {
	return hosts.map((entry) => [
		entry.host,
		"report" in entry ? entry.report.plugins : "stopped" in entry ? "stopped" : (entry.error as Error).message,
	]);
}

/** The state entry of `id`. */
const stateOf = (state: unknown, id: string) =>
	(state as Record<string, { status: string; error?: { message: string } }>)[`session|${id}`];

describe("starts on demand", () => {
	it("starts a worker for the first hold: starting, then running; its link binds the holder", async () => {
		const { server, workers, starts } = await fleet();
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1") !== undefined);
		expect(stateOf(workers.state.value, "S1")?.status).toBe("starting");
		await until(() => notes.state.value.kind === "live");
		expect(notes.label.value).toBe("S1 v1");
		await until(() => stateOf(workers.state.value, "S1")?.status === "running");
		expect(starts).toEqual(["session|S1"]);
		notes.release();
	});

	it("binds through a load longer than the heartbeat: the link is made at the fork, the worker connects first", async () => {
		const { server, behaviours } = await fleet({ heartbeat: { ping: 50, close: 200 } });
		behaviours.set("S1", { loadMs: 600 });
		const notes = await server.get(Notes, { id: "S1" }, context);
		expect(notes.label.value).toBe("S1 v1");
		notes.release();
	});
});

describe("failures stay until retry or a rollout (R2)", () => {
	it("a start that throws fails the address: holders fail waiting with it, a new hold forks nothing; retry starts it", async () => {
		let fail = true;
		const { server, workers, errors, starts } = await fleet({
			start: async () => {
				if (fail) throw new Error("no data dir");
				return {};
			},
		});
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "failed");
		expect(notes.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "unavailable", message: "worker failed to start" } },
		});
		expect(stateOf(workers.state.value, "S1")).toMatchObject({
			status: "failed",
			error: { message: "worker failed to start" },
		});
		const again = server.hold(Notes, { id: "S1" }, context);
		await until(() => again.state.value.kind === "failed");
		expect(starts).toEqual(["session|S1"]);
		// The full error only for the app's logs (decision "Slice 10 fix round, worker errors in public").
		expect(errors).toMatchObject([
			{ kind: "worker_failed", address: "session|S1", error: { message: "no data dir" } },
		]);
		fail = false;
		await workers.retry(Session({ id: "S1" }), context);
		await until(() => notes.state.value.kind === "live" && again.state.value.kind === "live");
		expect(stateOf(workers.state.value, "S1")?.status).not.toBe("failed");
		notes.release();
		again.release();
	});

	it("a crash after ready stays failed (worker_exited, worker_failed), nothing restarts", async () => {
		const { server, workers, errors, starts } = await fleet();
		const notes = await server.get(Notes, { id: "S1" }, context);
		const control = await server.get(Control, { id: "S1" }, context);
		await control.crash(7, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("worker exited (code 7)");
		expect(errors.map(({ kind }) => kind)).toEqual(["worker_exited", "worker_failed"]);
		await until(() => notes.state.value.kind === "failed");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(starts).toEqual(["session|S1"]);
		notes.release();
		control.release();
	});

	it("a fatal crosses redacted: the secret never reaches the public state", async () => {
		const { server, workers, errors, behaviours } = await fleet();
		behaviours.set("S1", { fatal: "boom secret-token-123" });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("boom [redacted]");
		// Public: the state; the report's stderr tail is the app's to redact (a later test).
		expect(JSON.stringify(workers.state.value)).not.toContain("secret");
		expect(errors.find(({ kind }) => kind === "worker_failed")).toMatchObject({
			error: { message: "boom [redacted]" },
		});
		notes.release();
	});

	it("a link lost while its child lives (a blocked event loop past the heartbeat): killed after the grace, failed", async () => {
		const { server, workers, starts, errors } = await fleet({ heartbeat: { ping: 100, close: 300 } });
		const notes = await server.get(Notes, { id: "S1" }, context);
		const control = await server.get(Control, { id: "S1" }, context);
		await control.block(20_000, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "stopping", 5_000);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed", 10_000);
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("worker exited (SIGKILL)");
		expect(errors.find(({ kind }) => kind === "worker_failed")).toMatchObject({
			error: { message: "worker: link lost" },
		});
		expect(starts).toEqual(["session|S1"]);
		notes.release();
		control.release();
	}, 20_000);

	it("an exit before started fails the start; a worker that never connects is killed at the start timer", async () => {
		const { server, workers, behaviours, errors } = await fleet();
		behaviours.set("S1", { exit: 3 });
		const exited = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("worker failed to start");
		expect(errors.find(({ kind }) => kind === "worker_failed")).toMatchObject({
			error: { message: expect.stringContaining("exited before it was ready (code 3)") },
		});
		exited.release();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			behaviours.set("S2", { connect: false });
			const silent = server.hold(Notes, { id: "S2" }, context);
			await vi.waitFor(() => expect(stateOf(workers.state.value, "S2")?.status).toBe("starting"), {
				timeout: 5_000,
			});
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.waitFor(() => expect(stateOf(workers.state.value, "S2")?.status).toBe("failed"), { timeout: 5_000 });
			expect(stateOf(workers.state.value, "S2")?.error?.message).toBe("worker failed to start");
			expect(errors.findLast(({ kind }) => kind === "worker_failed")).toMatchObject({
				error: { message: expect.stringContaining("did not start within 60 s") },
			});
			silent.release();
		} finally {
			vi.useRealTimers();
		}
	});

	it("the start timer covers only the start: a slow load after connecting is not killed (Q4)", async () => {
		const { server, workers, behaviours } = await fleet();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			behaviours.set("S1", { hang: true });
			const notes = server.hold(Notes, { id: "S1" }, context);
			await vi.waitFor(() => expect(stateOf(workers.state.value, "S1")?.status).toBe("starting"), {
				timeout: 5_000,
			});
			await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(120_000);
			expect(stateOf(workers.state.value, "S1")?.status).toBe("starting");
			expect(notes.state.value.kind).toBe("loading");
			notes.release();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("keep-alive (D9, R3, Q5)", () => {
	it("stops a worker idle since idleMs; a hold keeps one running; busy keeps it too", async () => {
		const { server, workers } = await fleet({ idleMs: 200 });
		const held = await server.get(Notes, { id: "held" }, context);
		const released = await server.get(Notes, { id: "free" }, context);
		const control = await server.get(Control, { id: "busy" }, context);
		await control.busy(1_500, context);
		control.release();
		released.release();
		await until(() => stateOf(workers.state.value, "free") === undefined, 5_000);
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(stateOf(workers.state.value, "held")?.status).toBe("running");
		expect(stateOf(workers.state.value, "busy")?.status).toBe("running");
		await until(() => stateOf(workers.state.value, "busy") === undefined, 5_000);
		held.release();
	}, 20_000);

	it("1,000 sequential local calls in a worker nobody holds send no message (Sol)", async () => {
		const { server, behaviours, output } = await fleet();
		behaviours.set("S1", { localCalls: 1_000 });
		// Released at once: the calls run 300 ms after the load, with no hold arriving (no reference keeps it busy).
		(await server.get(Notes, { id: "S1" }, context)).release();
		await until(() => output.some((line) => line.startsWith("session|S1 local calls sent")));
		expect(output).toContain("session|S1 local calls sent 0");
	});
});

describe("stop", () => {
	it("suspends while held: holders fail waiting suspended, nothing starts; forgotten with the last holder (Q3)", async () => {
		const { server, workers, starts } = await fleet();
		const notes = await server.get(Notes, { id: "S1" }, context);
		await workers.stop(Session({ id: "S1" }), context);
		expect(stateOf(workers.state.value, "S1")).toBeUndefined();
		await until(() => notes.state.value.kind === "failed");
		expect(notes.state.value).toMatchObject({
			cause: { kind: "waiting", error: { message: "session|S1: suspended" } },
		});
		expect(starts).toEqual(["session|S1"]);
		notes.release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const again = await server.get(Notes, { id: "S1" }, context);
		expect(starts).toEqual(["session|S1", "session|S1"]);
		again.release();
	});

	it("a stop during a start waits for it, then stops; a start during a stop waits for its exit", async () => {
		const { server, workers, behaviours, starts } = await fleet();
		behaviours.set("S1", { loadMs: 300 });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1") !== undefined);
		await workers.stop(Session({ id: "S1" }), context);
		expect(stateOf(workers.state.value, "S1")).toBeUndefined();
		notes.release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		behaviours.set("S1", { log: undefined });
		const again = await server.get(Notes, { id: "S1" }, context);
		const stopping = workers.stop(Session({ id: "S1" }), context);
		again.release();
		await stopping;
		const third = await server.get(Notes, { id: "S1" }, context);
		expect(starts).toHaveLength(3);
		third.release();
	});

	it("runs the worker's closers in reverse order at its stop", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-log-"));
		const { server, workers, behaviours } = await fleet();
		behaviours.set("S1", { log: join(dir, "log"), closeMs: 50 });
		const notes = await server.get(Notes, { id: "S1" }, context);
		notes.release();
		await workers.stop(Session({ id: "S1" }), context);
		expect(await readFile(join(dir, "log"), "utf8")).toBe("store\nhost\n");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("close", () => {
	it("cancels a start waiting in start(address): nothing forks; new starts reject; no worker_failed at shutdown", async () => {
		let waiting = false;
		const { server, workers, errors } = await fleet({
			start: async (address, startContext) => {
				if (address.key === "session|wait") {
					waiting = true;
					await new Promise((_, reject) =>
						startContext.abortSignal?.addEventListener("abort", () => reject(startContext.abortSignal?.reason)),
					);
				}
				return {};
			},
		});
		const running = await server.get(Notes, { id: "S1" }, context);
		const waits = server.hold(Notes, { id: "wait" }, context);
		await until(() => waiting);
		await workers.close(context);
		expect(workers.state.value).toEqual({});
		expect(errors).toEqual([]);
		const late = server.hold(Notes, { id: "late" }, context);
		await until(() => late.state.value.kind === "failed");
		expect(late.state.value).toMatchObject({ cause: { error: { code: "released", reason: "closed" } } });
		for (const ref of [running, waits, late]) ref.release();
	});
});

describe("the rollout step (§4)", () => {
	it("ships the current set to running workers, retries held failed ones, lists each", async () => {
		const { server, workers, plugins, label } = await fleet();
		const one = await server.get(Notes, { id: "S1" }, context);
		const two = await server.get(Notes, { id: "S2" }, context);
		const control = await server.get(Control, { id: "S3" }, context);
		const failed = await server.get(Notes, { id: "S3" }, context);
		await control.crash(1, context);
		await until(() => stateOf(workers.state.value, "S3")?.status === "failed");
		await label("v2");
		await until(() => plugins.state.value.dirty.includes("@test/notes"));
		const result = await plugins.rollout(
			[workers.step("workers")],
			await plugins.build(plugins.state.value.dirty, context),
			context,
		);
		const hosts = result.steps[0]!.hosts;
		expect(listed(hosts).sort()).toEqual([
			["session|S1", { added: [], changed: ["@test/notes"], removed: [] }],
			["session|S2", { added: [], changed: ["@test/notes"], removed: [] }],
			["session|S3", { added: ["@test/notes"], changed: [], removed: [] }],
		]);
		await until(() => one.label.value === "S1 v2" && two.label.value === "S2 v2" && failed.label.value === "S3 v2");
		expect(plugins.state.value.dirty).toEqual([]);
		for (const ref of [one, two, failed, control]) ref.release();
	});

	it("lists a worker stopped cleanly during it as stopped and one that crashed with its error (it stays dirty)", async () => {
		const { server, workers, plugins, label } = await fleet();
		const one = await server.get(Notes, { id: "S1" }, context);
		const control = await server.get(Control, { id: "S2" }, context);
		await label("v2");
		await until(() => plugins.state.value.dirty.includes("@test/notes"));
		const built = await plugins.build(plugins.state.value.dirty, context);
		// Both workers block their event loops: their reloads wait; S1 is stopped meanwhile, S2 crashes before reading it.
		const first = await server.get(Control, { id: "S1" }, context);
		await first.block(400, context);
		await control.blockThenCrash(400, context);
		// Their event loops are blocked once their timers ran.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const rolling = plugins.rollout([workers.step("workers")], built, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const stopped = workers.stop(Session({ id: "S1" }), context);
		const result = await rolling;
		await stopped;
		expect(listed(result.steps[0]!.hosts).sort()).toEqual([
			["session|S1", "stopped"],
			["session|S2", "worker: its link is gone"],
		]);
		expect(plugins.state.value.dirty).toEqual(["@test/notes"]);
		for (const ref of [one, first, control]) ref.release();
	});

	it("a worker starting during it gets the new set: a start after the rollout loads it", async () => {
		const { server, workers, plugins, label } = await fleet();
		await label("v2");
		await until(() => plugins.state.value.dirty.includes("@test/notes"));
		await plugins.rollout(
			[workers.step("workers")],
			await plugins.build(plugins.state.value.dirty, context),
			context,
		);
		const notes = await server.get(Notes, { id: "S9" }, context);
		expect(notes.label.value).toBe("S9 v2");
		notes.release();
	});

	it("an aborted wait lists the worker aborted; its late reply keeps the child's slot until it arrives", async () => {
		const { server, workers, plugins, label } = await fleet();
		const control = await server.get(Control, { id: "S1" }, context);
		const notes = await server.get(Notes, { id: "S1" }, context);
		await label("v2");
		await until(() => plugins.state.value.dirty.includes("@test/notes"));
		const built = await plugins.build(plugins.state.value.dirty, context);
		await control.block(300, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const abort = new AbortController();
		const step = workers.step("workers");
		const waited = plugins.rollout([step], built, withAbortSignal(abort.signal, context));
		setTimeout(() => abort.abort(new Error("stop waiting")), 50);
		const first = await waited;
		expect(listed(first.steps[0]!.hosts)).toEqual([["session|S1", "stop waiting"]]);
		expect(plugins.state.value.dirty).toEqual(["@test/notes"]);
		await label("v3");
		await until(() => plugins.state.value.dirty.includes("@test/notes"));
		const next = await plugins.rollout([step], await plugins.build(plugins.state.value.dirty, context), context);
		expect(listed(next.steps[0]!.hosts)).toEqual([
			["session|S1", { added: [], changed: ["@test/notes"], removed: [] }],
		]);
		await until(() => notes.label.value === "S1 v3");
		control.release();
		notes.release();
	});
});

describe("GC", () => {
	// Real forks are costly (100 took the suite from 103 s to 700 s on one CPU at 1,000): 100 here; the 1,000 failed and
	// retried addresses below cover the per-address records and suspensions at scale.
	it("100 addresses started and stopped leave no state, no record, no suspension (Astra, Sol)", async () => {
		const refs: WeakRef<object>[] = [];
		const { server, workers } = await fleet({
			start: async (address) => {
				refs.push(new WeakRef(address));
				return {};
			},
		});
		// Twenty at a time: each a real fork, start, hold, stop and exit.
		for (let batch = 0; batch < 5; batch++) {
			await Promise.all(
				Array.from({ length: 20 }, async (_, index) => {
					const id = `R${batch * 20 + index}`;
					const notes = await server.get(Notes, { id }, context);
					notes.release();
					await workers.stop(Session({ id }), context);
				}),
			);
		}
		expect(workers.state.value).toEqual({});
		await expectCollected(...refs);
	}, 120_000);

	it("1,000 failed and retried addresses leave no state, no record and no suspension", async () => {
		const refs: WeakRef<object>[] = [];
		const { server, workers } = await fleet({
			start: async (address) => {
				refs.push(new WeakRef(address));
				throw new Error("no worker");
			},
		});
		for (let i = 0; i < 1_000; i++) {
			const id = `A${i}`;
			const ref = server.hold(Notes, { id }, context);
			await until(() => ref.state.value.kind === "failed");
			ref.release();
			await workers.stop(Session({ id }), context);
			await workers.retry(Session({ id }), context);
		}
		expect(workers.state.value).toEqual({});
		await expectCollected(...refs.slice(0, 50));
	}, 120_000);
});

describe("fix round 2", () => {
	// Astra's recheck R3: a throwing `principal(address)` reached the guest with its message, the child left starting.
	it("a throwing principal hook fails the start with the public message; the error stays private", async () => {
		const { server, workers, errors } = await fleet({
			principal: () => {
				throw new Error("secret token=sk-1 at /home/owner/private");
			},
		});
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "failed");
		expect(JSON.stringify(notes.state.value)).not.toContain("secret");
		expect(notes.state.value).toMatchObject({
			kind: "failed",
			cause: { error: { message: "worker failed to start" } },
		});
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(stateOf(workers.state.value, "S1")).toMatchObject({ error: { message: "worker failed to start" } });
		// Opus's second recheck: the component's own kill of a failed start is no `worker_exited`.
		await until(() => errors.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(errors).toMatchObject([
			{ kind: "worker_failed", address: "session|S1", error: { message: expect.stringContaining("secret") } },
		]);
		notes.release();
	});

	it("a throwing authorize refuses the hold (forbidden); the error stays private, reported authorize_failed", async () => {
		const { server, errors, starts } = await fleet({
			authorize: () => {
				throw new Error("secret lookup");
			},
		});
		const remote = createHost<TestPrincipal>({ onError: () => {} });
		const [up, down] = memoryLinkPair();
		server.accept(up, { principal: { kind: "guest", id: "g" } }, context);
		remote.connect(down, { principal: { kind: "server" } }, context);
		await remote.load([], context);
		const notes = remote.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind !== "loading");
		expect(JSON.stringify(notes.state.value)).not.toContain("secret");
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "forbidden" } } });
		expect([errors, starts]).toMatchObject([[{ kind: "authorize_failed", address: "session|S1" }], []]);
		notes.release();
		await remote.close(context);
	});
});

describe("fix round 1", () => {
	it("close during a forked start that never connects returns at once, no failure (Opus F1)", async () => {
		const { server, workers, behaviours, errors } = await fleet();
		behaviours.set("S1", { connect: false });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "starting");
		const started = Date.now();
		await workers.close(context);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(errors).toEqual([]);
		notes.release();
	});

	it("close during an app's start that ignores its signal returns at once; nothing forks after it (Sol)", async () => {
		let forked = false;
		const { server, workers, errors } = await fleet({ start: () => new Promise<never>(() => {}) });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await workers.close(context);
		forked = stateOf(workers.state.value, "S1") !== undefined;
		expect([forked, errors]).toEqual([false, []]);
		notes.release();
	});

	it("a stop during the worker's startup is a stop: its closers run, nothing fails (Astra)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-log-"));
		const { server, workers, behaviours, errors } = await fleet();
		behaviours.set("S1", { loadMs: 5_000, closeMs: 200, log: join(dir, "log") });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1") !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await workers.stop(Session({ id: "S1" }), context);
		expect(errors).toEqual([]);
		expect(await readFile(join(dir, "log"), "utf8")).toBe("store\nhost\n");
		notes.release();
		await rm(dir, { recursive: true, force: true });
	});

	it("a reload queued behind one the child never answers settles when the child exits (Astra)", async () => {
		const { server, workers, plugins, label } = await fleet();
		const control = await server.get(Control, { id: "S1" }, context);
		await label("v2");
		await until(() => plugins.state.value.dirty.length > 0);
		const built = await plugins.build(plugins.state.value.dirty, context);
		await control.blockThenCrash(600, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const first = plugins.rollout([workers.step("one")], built, context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = plugins.rollout([workers.step("two")], built, context);
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.map((result) => listed(result.steps[0]!.hosts))).toEqual([
			[["session|S1", "worker: its link is gone"]],
			[["session|S1", "worker: its link is gone"]],
		]);
		control.release();
	});

	it("a plugin whose evaluation failed is shipped again by the next rollout and stays dirty (Astra)", async () => {
		const { server, workers, plugins, root } = await fleet();
		const notes = await server.get(Notes, { id: "S1" }, context);
		await writeFile(
			join(root, "notes", "label.ts"),
			'throw new Error("evaluation failed");\nexport const label = "v2";\n',
		);
		await until(() => plugins.state.value.dirty.length > 0);
		const built = await plugins.build(plugins.state.value.dirty, context);
		const failed = (result: { steps: readonly { hosts: readonly RolloutHost[] }[] }) => {
			const [entry] = result.steps[0]!.hosts;
			return entry !== undefined && "report" in entry ? entry.report.failed.map(({ plugin }) => plugin) : entry;
		};
		expect(failed(await plugins.rollout([workers.step("one")], built, context))).toEqual(["@test/notes"]);
		expect(failed(await plugins.rollout([workers.step("two")], built, context))).toEqual(["@test/notes"]);
		expect(plugins.state.value.dirty).toEqual(["@test/notes"]);
		expect(notes.label.value).toBe("S1 v1");
		notes.release();
	});

	it("two rollouts started together each ship their own build; the later one stays (Astra)", async () => {
		const { server, workers, plugins, label } = await fleet();
		const notes = await server.get(Notes, { id: "S1" }, context);
		await label("v2");
		const v2 = await plugins.build(["@test/notes"], context);
		await label("v3");
		const v3 = await plugins.build(["@test/notes"], context);
		const results = await Promise.all([
			plugins.rollout([workers.step("v2")], v2, context),
			plugins.rollout([workers.step("v3")], v3, context),
		]);
		for (const result of results) {
			expect(listed(result.steps[0]!.hosts)).toEqual([
				["session|S1", { added: [], changed: ["@test/notes"], removed: [] }],
			]);
		}
		await until(() => notes.label.value === "S1 v3");
		notes.release();
	});

	it("reaps a worker that closed its own IPC channel and lives on: killed after the grace, failed (Sol)", async () => {
		const { server, workers, behaviours } = await fleet();
		behaviours.set("S1", { disconnectAndBlock: true });
		const notes = await server.get(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed", 10_000);
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("worker exited (SIGKILL)");
		await until(() => notes.state.value.kind === "failed");
		notes.release();
	}, 15_000);

	it("keeps no reload report once consumed: the reload queue settles to nothing (Sol)", async () => {
		const env = await fleet();
		const notes = await env.server.get(Notes, { id: "S1" }, context);
		const report = await (async () => {
			await env.label("v2");
			const built = await env.plugins.build(["@test/notes"], context);
			const result = await env.plugins.rollout([env.workers.step("workers")], built, context);
			const [entry] = result.steps[0]!.hosts;
			if (entry === undefined || !("report" in entry)) throw new Error("no report");
			return new WeakRef(entry.report);
		})();
		await expectCollected(report);
		notes.release();
	});

	it("keeps a worker's stderr out of the public state: only worker_failed carries its tail (Astra)", async () => {
		const { server, workers, behaviours, errors } = await fleet();
		behaviours.set("S1", { fatal: "boom secret-token-123" });
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(JSON.stringify(workers.state.value)).not.toContain("secret");
		expect(JSON.stringify(notes.state.value)).not.toContain("secret");
		const failure = errors.find(({ kind }) => kind === "worker_failed");
		expect(failure).toMatchObject({ stderrTail: expect.stringContaining("secret-token-123") });
		notes.release();
	});
});
