// Tests of the workers component (slice 10 §3, §4): starts on demand (the link made at the fork, `started` on
// `connect`, the start timer covering only the start), failures that stay (a crash, a `fatal`, a failed start: no fork
// for a new hold, holders `failed { waiting }`) until `retry` or a rollout, a running worker's lost link recovered from
// once a minute, idle stops and `busy`, `stop` and its suspension, the per-address queue, `close`, the rollout step,
// stale lock files cleared, nothing kept of 1,000 addresses, and the worker base (an edit after its build runs in no
// worker; forks without source maps; a start waits for the build; a broken entry fails every start; close keeps the
// files until its workers exited), a worker's exit published only after its link's work ended, and its incarnation in
// the state before its first call is handled.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withAbortSignal } from "../../../src/context/index.ts";
import { arr, local, method, obj, str } from "../../../src/contracts/index.ts";
import { isChordError } from "../../../src/data/index.ts";
import { defineState } from "../../../src/documents/index.ts";
import { allow, createHost, defineFacet, deny } from "../../../src/host/index.ts";
import { memoryLinkPair } from "../../../src/link/index.ts";
import type { RolloutHost } from "../../../src/node/plugins/index.ts";
import type { Workers } from "../../../src/node/workers/index.ts";
import { constant } from "../../../src/state/index.ts";
import { expectCollected, holdNextCommit, memoryStore } from "../../support.ts";
import { Control, Reports } from "../fixtures/workers/control.ts";
import { context, ENTRY, fleet, Notes, Session, type TestPrincipal, until } from "./support.ts";

/** A step's hosts as `[host, what]`. */
function listed(hosts: readonly RolloutHost[]) {
	return hosts.map((entry) => [
		entry.host,
		entry.kind === "reloaded"
			? entry.report.plugins
			: entry.kind === "stopped"
				? "stopped"
				: (entry.error as Error).message,
	]);
}

/** The process lock module, for a process that takes a lock and is killed holding it. */
const LOCK_MODULE = fileURLToPath(new URL("../../../src/node/workers/lock.ts", import.meta.url));

/** The state entry of `id`. */
const stateOf = (state: unknown, id: string) =>
	(state as Record<string, { status: string; pid?: number; incarnation?: string; error?: { message: string } }>)[
		`session|${id}`
	];

/** The server's journal of its workers' reports. */
const Journal = local("test.journal", {
	version: 1,
	params: {},
	members: { lines: arr(str()), append: method(str()) },
});

const LINES = { schema: obj({ lines: arr(str()) }), version: 1, initial: () => ({ lines: [] }) } as const;

const Lines = defineState("lines", LINES);

const StoredLines = defineState("lines", { ...LINES, persist: true, checkpointWhen: () => false });

/**
 * A server facet serving `Reports` into `Journal` (persisted when `persist`): a report is `received` (with what
 * `seen` says of its call), waits for `before`, then appends its text in a transaction under its call's `ctx`;
 * `outcomes` gets how that ended.
 */
function reporting(
	log: { readonly received: string[]; readonly outcomes: string[] },
	options: {
		readonly persist?: boolean;
		readonly before?: Promise<void>;
		readonly seen?: (incarnation: string) => string;
	} = {},
) {
	return defineFacet<TestPrincipal>((facet) => {
		facet.serve(Journal, (_, self) => {
			const lines = self.state(options.persist === true ? StoredLines : Lines);
			return {
				lines: self.derive([lines], ([value]) => value.lines),
				append: async (text, ctx) => {
					await lines.change((draft) => void draft.lines.push(text), ctx);
					return null;
				},
			};
		});
		facet.serve(Reports, (_params, _principal, self) => {
			const journal = self.get(Journal, {});
			return {
				variant: "main",
				members: {
					report: async (text, ctx) => {
						log.received.push(options.seen === undefined ? text : `${text} ${options.seen(ctx.incarnation)}`);
						await options.before;
						await journal.append(text, ctx).then(
							() => log.outcomes.push(`${text} committed`),
							(error: unknown) => log.outcomes.push(`${text} ${isChordError(error) ? error.code : "threw"}`),
						);
						return null;
					},
				},
			};
		});
	});
}

/** Whether process `pid` lives. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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

	it("passes admit to its route: a denied principal starts no worker, an allowed one does (slice 14 §2.3)", async () => {
		const denied = await fleet({ admit: () => constant(deny("no workers for you")) });
		const refused = denied.server.hold(Notes, { id: "S1" }, context);
		await until(() => refused.state.value.kind === "failed");
		expect(refused.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no workers for you" } },
		});
		// Nothing forked, nothing even asked to start.
		expect([denied.starts, stateOf(denied.workers.state.value, "S1")]).toEqual([[], undefined]);
		refused.release();
		const allowed = await fleet({ admit: () => constant(allow(null)) });
		const notes = allowed.server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "live");
		expect(allowed.starts).toEqual(["session|S1"]);
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

describe('the worker base (decision "Workers start from the base code the server booted with")', () => {
	it("a worker started after an edit of the entry's imported source runs the code the base was built with", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-base-"));
		// The fixture worker, plus a line naming its label and the file it was forked from.
		await writeFile(join(dir, "label.ts"), 'export const label = "boot";\n');
		await writeFile(
			join(dir, "entry.ts"),
			[
				`import ${JSON.stringify(ENTRY)};`,
				'import { label } from "./label.ts";',
				'process.stdout.write(["label", label, process.argv[1]].join(" ") + "\\n");',
			].join("\n"),
		);
		const { server, workers, output } = await fleet({ entry: join(dir, "entry.ts") });
		expect(workers.built).toBeUndefined();
		const built = await workers.build();
		expect(built.kind === "built" ? [...built.inputs.keys()] : built).toEqual(
			expect.arrayContaining([join(dir, "entry.ts"), join(dir, "label.ts"), ENTRY]),
		);
		// Half way through an edit: the source on disk no longer even parses.
		await writeFile(join(dir, "label.ts"), "export const label = ;\n");
		const notes = await server.get(Notes, { id: "S1" }, context);
		expect(notes.label.value).toBe("S1 v1");
		const line = output.find((each) => each.startsWith("session|S1 label "));
		expect(line).toMatch(/^session\|S1 label boot /);
		notes.release();
		// The worker ran from the bundle's file, which the component's close removes.
		const forkedFrom = line!.split(" ")[3]!;
		expect(existsSync(forkedFrom)).toBe(true);
		await workers.close(context);
		expect(existsSync(forkedFrom)).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	it("forks without --enable-source-maps: Node parses no map of the base, whose maps lie beside its files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-maps-"));
		await writeFile(
			join(dir, "entry.ts"),
			[
				`import ${JSON.stringify(ENTRY)};`,
				'process.stdout.write(["maps", process.sourceMapsEnabled, process.argv[1]].join(" ") + "\\n");',
			].join("\n"),
		);
		const { server, workers, output } = await fleet({ entry: join(dir, "entry.ts") });
		const notes = await server.get(Notes, { id: "S1" }, context);
		const line = output.find((each) => each.startsWith("session|S1 maps "));
		const [, , enabled, forkedFrom] = line!.split(" ");
		expect(enabled).toBe("false");
		expect(existsSync(`${forkedFrom}.map`)).toBe(true);
		notes.release();
		await workers.close(context);
		await rm(dir, { recursive: true, force: true });
	});

	it("close keeps the base's files until its workers exited: a closer's first lazy import still loads (Astra)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-base-"));
		const { server, workers, behaviours, errors } = await fleet();
		behaviours.set("S1", { lazyOnClose: join(dir, "closed") });
		(await server.get(Notes, { id: "S1" }, context)).release();
		await workers.close(context);
		expect(await readFile(join(dir, "closed"), "utf8")).toBe("lazy chunk loaded at close");
		expect(errors).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});

	it("a start waits for the base's build, and starts it when nothing did", async () => {
		const { server, workers, starts } = await fleet();
		expect(workers.built).toBeUndefined();
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "live");
		expect(workers.built?.kind).toBe("built");
		expect(starts).toEqual(["session|S1"]);
		notes.release();
	});

	it("a broken entry fails its build and every start (worker_failed, the public start error); nothing forks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-workers-base-"));
		await writeFile(join(dir, "entry.ts"), "export const broken = ;\n");
		const { server, workers, errors, starts } = await fleet({ entry: join(dir, "entry.ts") });
		const built = await workers.build();
		expect(built.kind === "failed" ? (built.error as Error).message : built).toMatch(/Unexpected ";"/);
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "failed");
		expect(notes.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "unavailable", message: "worker failed to start" } },
		});
		notes.release();
		// The app's start data is not asked for: the base fails the start first.
		expect(starts).toEqual([]);
		expect(errors).toMatchObject([{ kind: "worker_failed", address: "session|S1" }]);
		expect(stateOf(workers.state.value, "S1")?.status).toBe("failed");
		await rm(dir, { recursive: true, force: true });
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

	it("a running worker's lost link (a blocked event loop past the heartbeat): killed after the grace, its holders get a new worker past the lock file the kill left; a second within a minute fails the address", async () => {
		const { server, workers, starts, errors } = await fleet({ heartbeat: { ping: 100, close: 300 } });
		const notes = await server.get(Notes, { id: "S1" }, context);
		const control = await server.get(Control, { id: "S1" }, context);
		await control.block(20_000, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "stopping", 5_000);
		// SIGKILL skipped the child's exit hooks: on macOS and the BSDs its lock's socket file was left, and the next start
		// cleared it (else the new child would fail closed on it).
		await until(() => starts.length === 2 && notes.state.value.kind === "live", 15_000);
		await until(() => stateOf(workers.state.value, "S1")?.status === "running");
		expect(errors).toMatchObject([
			{ kind: "worker_link_lost", address: "session|S1", error: { message: "worker: link lost" } },
		]);
		// The new worker loses its link too: no restart loop, the address fails until `retry`.
		await until(() => control.state.value.kind === "live");
		await control.block(20_000, context);
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed", 15_000);
		expect(stateOf(workers.state.value, "S1")?.error?.message).toBe("worker lost its link");
		expect(errors.find(({ kind }) => kind === "worker_failed")).toMatchObject({
			error: { message: "worker: link lost" },
		});
		await until(() => notes.state.value.kind === "failed");
		expect(starts).toEqual(["session|S1", "session|S1"]);
		notes.release();
		control.release();
	}, 45_000);

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
			// The incarnation comes with the link's handshake, after `started` cleared the start timer: a forked worker
			// connects in its own time, so advancing the clock before it would fire the timer (CI flake).
			await vi.waitFor(() => expect(stateOf(workers.state.value, "S1")?.incarnation).toBeDefined(), {
				timeout: 5_000,
			});
			expect(stateOf(workers.state.value, "S1")?.status).toBe("starting");
			await vi.advanceTimersByTimeAsync(120_000);
			expect(stateOf(workers.state.value, "S1")?.status).toBe("starting");
			expect(notes.state.value.kind).toBe("loading");
			notes.release();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('stale lock files (macOS, the BSDs; decision "Stale lock files are cleared by the starter")', () => {
	it("a start clears the lock file a killed worker of an earlier server left: the worker runs", async () => {
		const { server, workers, root } = await fleet();
		// What an earlier server's worker SIGKILLed while holding the lock leaves (nothing on Linux: an abstract socket).
		const name = `chord-test:${root}:${Session({ id: "S1" }).key}`;
		const script = `const { processLock } = await import(${JSON.stringify(LOCK_MODULE)}); await processLock(${JSON.stringify(name)}, {}); process.kill(process.pid, "SIGKILL");`;
		const killed = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			script,
		]);
		expect(killed.signal).toBe("SIGKILL");
		const notes = server.hold(Notes, { id: "S1" }, context);
		await until(() => notes.state.value.kind === "live");
		expect(stateOf(workers.state.value, "S1")?.status).not.toBe("failed");
		notes.release();
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
			return entry !== undefined && entry.kind === "reloaded"
				? entry.report.failed.map(({ plugin }) => plugin)
				: entry;
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

	it("reaps a worker that closed its own IPC channel and lives on: killed after the grace, a lost link its holder gets a new worker for (Sol)", async () => {
		const { server, workers, behaviours, starts, errors } = await fleet();
		behaviours.set("S1", { disconnectAndBlock: true });
		const notes = await server.get(Notes, { id: "S1" }, context);
		behaviours.delete("S1");
		await until(() => errors.some(({ kind }) => kind === "worker_link_lost"), 10_000);
		await until(() => starts.length === 2 && notes.state.value.kind === "live", 10_000);
		expect(stateOf(workers.state.value, "S1")?.status).not.toBe("failed");
		notes.release();
	}, 25_000);

	it("keeps no reload report once consumed: the reload queue settles to nothing (Sol)", async () => {
		const env = await fleet();
		const notes = await env.server.get(Notes, { id: "S1" }, context);
		const report = await (async () => {
			await env.label("v2");
			const built = await env.plugins.build(["@test/notes"], context);
			const result = await env.plugins.rollout([env.workers.step("workers")], built, context);
			const [entry] = result.steps[0]!.hosts;
			if (entry === undefined || entry.kind !== "reloaded") throw new Error("no report");
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

describe("a worker's exit (decision \"A worker's exit is published after its link's work ended\")", () => {
	it("a worker that reports and exits in the same turn: its link is closed before its exit is published, no transaction of its reports commits", async () => {
		const published = Promise.withResolvers<void>();
		const log = { received: [] as string[], outcomes: [] as string[] };
		const { server, workers, behaviours } = await fleet({
			// Each report's transaction runs right after the exit was published.
			facets: [{ name: "@test/reports", facet: reporting(log, { before: published.promise }) }],
			onError: (error) => {
				if (error.kind === "worker_exited") published.resolve();
			},
		});
		// The channel outlives the worker: nothing but the component closes its link at the exit.
		behaviours.set("S1", { holdsChannel: true });
		const journal = await server.get(Journal, {}, context);
		const control = await server.get(Control, { id: "S1" }, context);
		// One report whose handler waits when the worker exits, one sent in the turn of the exit.
		await control.report("waiting", context);
		await until(() => log.received.includes("waiting"));
		control.reportAndExit("last", context).catch(() => {});
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		await until(() => log.outcomes.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		// `last` was handled before the exit and aborted with it, or never handled.
		expect(log.outcomes.filter((outcome) => outcome !== "last unavailable")).toEqual(["waiting unavailable"]);
		expect(journal.lines.value).toEqual([]);
		journal.release();
		control.release();
	});

	it("a commit a report queued in the store before the exit lands before the exit is published; until then the state shows the worker and nothing starts", async () => {
		const store = await memoryStore();
		const log = { received: [] as string[], outcomes: [] as string[] };
		let journal: Awaited<ReturnType<typeof holdJournal>> | undefined;
		let atExit: readonly string[] | undefined;
		const { server, workers, starts, errors } = await fleet({
			store,
			facets: [{ name: "@test/reports", facet: reporting(log, { persist: true }) }],
			onError: (error) => {
				if (error.kind === "worker_exited") atExit = journal?.lines.value;
			},
		});
		const holdJournal = () => server.get(Journal, {}, context);
		journal = await holdJournal();
		const notes = await server.get(Notes, { id: "S1" }, context);
		const control = await server.get(Control, { id: "S1" }, context);
		const running = stateOf(workers.state.value, "S1");
		const held = holdNextCommit(store);
		await control.report("queued", context);
		await held.entered;
		await control.crash(7, context);
		// Its link is closed at its exit: the holder sees that at once.
		await until(() => notes.state.value.kind !== "live" && !alive(running!.pid!));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(stateOf(workers.state.value, "S1")).toEqual(running);
		expect(errors).toEqual([]);
		expect(starts).toEqual(["session|S1"]);
		held.release();
		await until(() => stateOf(workers.state.value, "S1")?.status === "failed");
		expect(atExit).toEqual(["queued"]);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(starts).toEqual(["session|S1"]);
		journal.release();
		notes.release();
		control.release();
		await workers.close(context);
		await server.close(context);
		await store.close(context);
	});

	it("a stop resolves once the exit was published, after the commits its worker queued", async () => {
		const store = await memoryStore();
		const log = { received: [] as string[], outcomes: [] as string[] };
		const { server, workers } = await fleet({
			store,
			facets: [{ name: "@test/reports", facet: reporting(log, { persist: true }) }],
		});
		const journal = await server.get(Journal, {}, context);
		const control = await server.get(Control, { id: "S1" }, context);
		const { pid } = stateOf(workers.state.value, "S1")!;
		const held = holdNextCommit(store);
		await control.report("queued", context);
		await held.entered;
		let stopped = false;
		const stop = (workers as Workers<typeof Session>).stop(Session({ id: "S1" }), context).then(() => {
			stopped = true;
		});
		await until(() => !alive(pid!));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(stopped).toBe(false);
		expect(stateOf(workers.state.value, "S1")?.status).toBe("stopping");
		held.release();
		await stop;
		expect(stateOf(workers.state.value, "S1")).toBeUndefined();
		expect(journal.lines.value).toEqual(["queued"]);
		journal.release();
		control.release();
		await workers.close(context);
		await server.close(context);
		await store.close(context);
	});
});

describe("a worker's incarnation", () => {
	it("is in the state before its first call is handled: a report its startup sends finds it, long before ready", async () => {
		const log = { received: [] as string[], outcomes: [] as string[] };
		let workers: Workers<typeof Session> | undefined;
		const seen = (incarnation: string): string => {
			const state = stateOf(workers?.state.value, "S1");
			return `${state?.status} ${state?.incarnation === incarnation ? "known" : "unknown"}`;
		};
		const env = await fleet({ facets: [{ name: "@test/reports", facet: reporting(log, { seen }) }] });
		workers = env.workers;
		env.behaviours.set("S1", { reportAtStart: "startup" });
		// What the state's watchers are told, as `status known?`.
		const published: string[] = [];
		const watch = await workers.state.watch(context);
		watch.start(async () => {
			const state = stateOf(workers?.state.value, "S1");
			if (state !== undefined) published.push(`${state.status} ${state.incarnation !== undefined}`);
		});
		const control = await env.server.get(Control, { id: "S1" }, context);
		// The startup's call was answered: the worker went on to `ready`.
		await until(() => stateOf(workers?.state.value, "S1")?.status === "running");
		await control.report("later", context);
		await until(() => log.received.length === 2);
		expect(log.received).toEqual(["startup starting known", "later running known"]);
		// Published at the handshake, not only with the next change of the worker's status.
		expect(published).toContain("starting true");
		watch.stop();
		const first = stateOf(workers.state.value, "S1")!.incarnation;
		expect(first).toEqual(expect.any(String));
		// Another run of the worker is another incarnation.
		await control.crash(7, context);
		await until(() => stateOf(workers?.state.value, "S1")?.status === "failed");
		expect(stateOf(workers.state.value, "S1")).not.toHaveProperty("incarnation");
		await workers.retry(Session({ id: "S1" }), context);
		await until(() => stateOf(workers?.state.value, "S1")?.status === "running");
		expect(stateOf(workers.state.value, "S1")!.incarnation).not.toBe(first);
		control.release();
	});
});
