// A session worker's memory, against the installed release (owner, 2026-11-16: "Session worker memory levers and a
// budget"). The test builds a server and a worker entry with the release's own options and levers
// (`bundleOptions`, the worker's V8 flags, Chord's minified worker base, the warm compile cache), serves the
// installed release's plugins, and runs, in each of several workers at once, a real Durable harness with pi-ai's
// Anthropic and OpenAI providers against a local HTTPS stub (`test/memory/`): idle, one streamed answer, a burst of
// 20 turns with tool calls, five subagents streaming at once, idle between. Each worker's USS is sampled every 250 ms
// from `/proc`; an idle phase ends once a worker's USS settled (`settled`), and the test fails when the USS ever exceeds
// the budget, naming the phase, the peak and the settled values. Not part of `npm test`: it needs the install
// (`P3_RELEASE`), and takes about two minutes.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { build } from "esbuild";
import { Sessions, SessionWorker } from "../../plugins/sessions/contract.ts";
import { bundleOptions, checkExternals, checkLean } from "../../scripts/build-release.ts";
import { ownerClient } from "../client.ts";
import { launch } from "../launched.ts";
import { startStub } from "../memory/stub.ts";

const { P3_RELEASE } = process.env;
if (P3_RELEASE === undefined)
	throw new Error("memory.test.ts: set P3_RELEASE to the install directory (npm run release:p3:local)");

/** The budget: no session worker's USS above it, in any phase. */
// 55 MiB, one budget for every Node p3 supports (owner, 2026-11-16). Not 45: after the five parallel streams glibc
// keeps about 10 MiB that it freed (`malloc`'s kept-free memory, 10 to 11 MiB against 4 to 6 after the burst), while
// the session's data is about 4 MiB of the heap; a glibc setting would return it, on Linux only. Not 50: Node 26's
// workers settle about 7 MiB above Node 24's (after the burst 42.5 against 35.0), and 50 failed one run in five there.
const BUDGET_MIB = 55;

/** How many workers run the schedule at once. */
const WORKERS = 4;

/** The phases after which a worker idles until the test tells it to go on (`SIGUSR2`), its memory settled. */
const IDLE = new Set(["idle", "streamed", "bursted", "subagented"]);

/** An idle phase lasts at least this long: V8's memory reducer starts some seconds after the last work. */
const SETTLE_MIN_MS = 12_000;

/** Settled: the USS moved less than this over `STABLE_MS`. */
const STABLE_MIB = 0.25;
const STABLE_MS = 4000;

/** An idle phase lasts at most this long, settled or not (the fixed pause the test had before). */
const SETTLE_MAX_MS = 40_000;

/** The phases a worker marks, in order (`test/memory/session.ts`). */
const PHASES = ["idle", "stream", "streamed", "burst", "bursted", "subagents", "subagented", "done"] as const;

/** A worker's samples: its USS in MiB, by time. */
type Samples = { t: number; uss: number }[];

/** A process's unique memory (USS) in MiB, from `/proc`; `undefined` once it is gone. */
async function uss(pid: number): Promise<number | undefined> {
	const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => undefined);
	if (rollup === undefined) return undefined;
	const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(rollup)?.[1] ?? 0);
	return (kb("Private_Clean") + kb("Private_Dirty")) / 1024;
}

/**
 * Whether a worker idle since `since` (ms since the epoch) settled by `now`: `SETTLE_MIN_MS` passed and its USS moved
 * less than `STABLE_MIB` over the last `STABLE_MS`, or `SETTLE_MAX_MS` passed.
 */
export function settled(samples: Samples, since: number, now: number): boolean {
	if (now - since >= SETTLE_MAX_MS) return true;
	if (now - since < SETTLE_MIN_MS) return false;
	const recent = samples.filter((sample) => sample.t >= now - STABLE_MS).map((sample) => sample.uss);
	return recent.length >= STABLE_MS / 250 - 1 && Math.max(...recent) - Math.min(...recent) < STABLE_MIB;
}

/** What a worker measured, by reading (MiB). */
export type Readings = {
	readonly idle: number;
	readonly streamed: number;
	readonly burstPeak: number;
	readonly bursted: number;
	readonly subagentsPeak: number;
	readonly subagented: number;
	/** The highest sample, and the phase it fell in. */
	readonly peak: number;
	readonly peakPhase: string;
};

/** A worker's readings from its samples and its marks (the time each phase began). */
export function readingsOf(samples: Samples, marks: ReadonlyMap<string, number>): Readings {
	const at = (phase: string) => marks.get(phase)!;
	const before = (phase: string) => samples.filter((sample) => sample.t < at(phase)).at(-1)?.uss ?? Number.NaN;
	const peakIn = (from: string, to?: string) =>
		Math.max(
			...samples
				.filter((sample) => sample.t >= at(from) && (to === undefined || sample.t < at(to)))
				.map((s) => s.uss),
		);
	const top = samples.reduce((best, sample) => (sample.uss > best.uss ? sample : best), samples[0]!);
	const phase =
		[...PHASES].reverse().find((name) => (marks.get(name) ?? Number.POSITIVE_INFINITY) <= top.t) ?? "start";
	return {
		idle: before("stream"),
		streamed: before("burst"),
		burstPeak: peakIn("burst", "subagents"),
		bursted: before("subagents"),
		subagentsPeak: peakIn("subagents"),
		subagented: samples.at(-1)!.uss,
		peak: top.uss,
		peakPhase: phase,
	};
}

/** The readings as one line, for the failure's message and the run's log. */
function line(readings: Readings): string {
	const mib = (value: number) => value.toFixed(1);
	return [
		`peak ${mib(readings.peak)} MiB in ${readings.peakPhase}`,
		`settled: idle ${mib(readings.idle)}, after the response ${mib(readings.streamed)}, after the burst ${mib(readings.bursted)}, after the subagents ${mib(readings.subagented)}`,
		`peaks: burst ${mib(readings.burstPeak)}, subagents ${mib(readings.subagentsPeak)}`,
	].join("; ");
}

/** Fails, naming the worker's phase, its peak and its settled values, when it went above `budget` MiB. */
export function withinBudget(readings: Readings, budget: number, who: string): void {
	assert.ok(readings.peak <= budget, `${who}: USS above ${budget} MiB: ${line(readings)}`);
}

/** p3's checkout. */
const P3 = fileURLToPath(new URL("../../", import.meta.url));

describe("a session worker's memory, from the release", () => {
	if (!existsSync("/proc/self/smaps_rollup")) {
		it.skip("needs /proc (Linux, Android) to read a process's USS: not measured here");
		return;
	}

	it(
		`stays within ${BUDGET_MIB} MiB of USS: idle, a streamed answer, a burst, five subagents`,
		{ timeout: 15 * 60_000 },
		async (t) => {
			const dir = await mkdtemp(join(tmpdir(), "p3-memory-"));
			t.after(() => rm(dir, { recursive: true, force: true }));
			// The server and the worker as the release builds them: the same options, the same checks.
			const dist = join(dir, "dist");
			const bundle = async (name: string, entry: string) =>
				(await build({ ...bundleOptions(dist), entryPoints: { [name]: join(P3, "test", "memory", entry) } }))
					.metafile;
			const [server, worker] = await Promise.all([bundle("server", "server.ts"), bundle("worker", "worker.ts")]);
			for (const metafile of [server, worker]) checkExternals(metafile);
			checkLean(worker, "worker.js");
			// What the bundles leave to `node_modules` (esbuild) comes from the install, as the release's own do.
			await symlink(join(P3_RELEASE, "node_modules"), join(dir, "node_modules"));
			const stub = await startStub(dir);
			t.after(() => stub.close());
			const phases = join(dir, "phases.jsonl");
			await writeFile(phases, "");
			const env = {
				...process.env,
				NODE_EXTRA_CA_CERTS: stub.certificate,
				P3_MEMORY_STUB: stub.url,
				P3_MEMORY_PHASES: phases,
				P3_MEMORY_ROOT: join(P3_RELEASE, "node_modules", "@earendil-works", "p3", "plugins"),
			};
			const launched = await launch([process.execPath, join(dist, "server.js")], join(dir, "data"), {
				env,
				cwd: dir,
			});
			t.after(() => launched.close("SIGKILL"));
			const client = await ownerClient(launched, context);
			t.after(() => client.close(context));
			const sessions = await client.get(Sessions, {}, context);
			for (let i = 0; i < WORKERS; i++) {
				await client.get(SessionWorker, { session: await sessions.create({}, context) }, context);
			}
			const pids = await launched.workers();
			assert.equal(pids.length, WORKERS);
			const samples = new Map(pids.map((pid) => [pid, [] as Samples]));
			// Which worker was told to go on after which idle phase, and how long that phase lasted.
			const told = new Map<string, number>();
			const marksOf = async () => {
				const lines = (await readFile(phases, "utf8")).split("\n").filter(Boolean);
				return lines.map((text) => JSON.parse(text) as { pid: number; phase: string; t: number });
			};
			for (const deadline = Date.now() + 12 * 60_000; ; await sleep(250)) {
				assert.ok(Date.now() < deadline, "the schedule did not end within 12 minutes");
				const t = Date.now();
				for (const pid of pids) {
					const value = await uss(pid);
					if (value !== undefined) samples.get(pid)!.push({ t, uss: value });
				}
				const marks = await marksOf();
				const failed = marks.find((mark) => mark.phase.startsWith("error"));
				assert.equal(failed, undefined, failed?.phase);
				if (pids.every((pid) => marks.some((mark) => mark.pid === pid && mark.phase === "done"))) break;
				// A worker idle in a phase whose memory settled goes on to the next.
				for (const pid of pids) {
					const last = marks.filter((mark) => mark.pid === pid).at(-1);
					const key = `${pid} ${last?.phase}`;
					if (last === undefined || !IDLE.has(last.phase) || told.has(key)) continue;
					if (!settled(samples.get(pid)!, last.t, t)) continue;
					told.set(key, t - last.t);
					process.kill(pid, "SIGUSR2");
				}
			}
			const marks = await marksOf();
			const all = pids.map((pid) => {
				const own = new Map(marks.filter((mark) => mark.pid === pid).map((mark) => [mark.phase, mark.t]));
				return { pid, readings: readingsOf(samples.get(pid)!, own) };
			});
			for (const { pid, readings } of all) console.log(`memory: worker ${pid}: ${line(readings)}`);
			console.log(`memory: idle phases, ms: ${[...told.values()].join(" ")}`);
			if (process.env.P3_MEMORY_OUT !== undefined) {
				await appendFile(
					process.env.P3_MEMORY_OUT,
					all.map(({ readings }) => `${JSON.stringify(readings)}\n`).join(""),
				);
			}
			for (const { pid, readings } of all) withinBudget(readings, BUDGET_MIB, `worker ${pid}`);
		},
	);
});

describe("the memory test's limit", () => {
	it("calls a worker settled once its USS held still for 4 s, 12 s into the phase at the earliest, 40 s at the latest", () => {
		const flat = (from: number, to: number, uss: (t: number) => number) =>
			Array.from({ length: (to - from) / 250 + 1 }, (_, i) => ({ t: from + i * 250, uss: uss(from + i * 250) }));
		assert.equal(
			settled(
				flat(0, 11_000, () => 30),
				0,
				11_000,
			),
			false,
		);
		assert.equal(
			settled(
				flat(0, 12_000, () => 30),
				0,
				12_000,
			),
			true,
		);
		// Still falling: not settled until it holds.
		const falling = flat(0, 20_000, (t) => 40 - t / 1000);
		assert.equal(settled(falling, 0, 20_000), false);
		assert.equal(settled(falling, 0, 40_000), true);
		// A step of 0.3 MiB 2 s ago.
		assert.equal(
			settled(
				flat(0, 14_000, (t) => (t < 12_000 ? 30 : 30.3)),
				0,
				14_000,
			),
			false,
		);
	});

	// The check must fail above the budget, naming what it saw.
	it("fails a worker above the budget with its phase, its peak and its settled values", () => {
		const marks = new Map(PHASES.map((phase, index) => [phase, 1000 * (index + 1)]));
		const samples = [1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500].map((t, index) => ({
			t,
			uss: [20, 30, 28, 44, 33, 56, 31, 30][index]!,
		}));
		const readings = readingsOf(samples, marks);
		assert.deepEqual(
			[
				readings.idle,
				readings.streamed,
				readings.burstPeak,
				readings.bursted,
				readings.subagentsPeak,
				readings.peakPhase,
			],
			[20, 28, 44, 33, 56, "subagents"],
		);
		assert.throws(
			() => withinBudget(readings, BUDGET_MIB, "worker 1"),
			/worker 1: USS above 55 MiB: peak 56\.0 MiB in subagents; settled: idle 20\.0, after the response 28\.0/,
		);
		withinBudget(
			readingsOf(
				samples.map((sample) => ({ ...sample, uss: Math.min(sample.uss, 55) })),
				marks,
			),
			BUDGET_MIB,
			"worker 2",
		);
	});
});
