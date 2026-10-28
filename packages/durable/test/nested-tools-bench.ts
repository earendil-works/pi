/**
 * Nested tool call storage benchmark. Per run, one model-issued tool makes `calls` parallel nested calls of `blob`,
 * each streaming `bytes` of output in 8 chunks `gapMs` apart; at depth 2 it makes them through `calls / 10` parallel
 * `fan` calls of 10 each. With `progress: false` the nested calls commit no running output. Reports commits, logical
 * bytes written (JSON of the storage writes) by write type, the stored size after each run, and the heap: its peak during a run, sampled every 5 ms, and what stays after a
 * run and a GC, both over the heap after a GC before the first run. A 2 ms gap is a fast tool such as `read`: it ends
 * before a second progress commit. A 50 ms gap streams for 400 ms, as a short `bash` command does, and commits progress
 * every 100 ms.
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/nested-tools-bench.ts [streaming|nesting]
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type Storage,
	type StorageWrite,
	ToolResultEntry,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

type Backend = "sqlite" | "jsonl";
type Scenario = {
	backend: Backend;
	calls: number;
	depth: 1 | 2;
	bytes: number;
	gapMs: number;
	/** Whether nested calls stream their running output to `pi.live`. */
	progress: boolean;
	runs: number;
};
type Written = Record<StorageWrite["type"], number>;
type Run = {
	commits: number;
	written: Written;
	storedBytes: number;
	ms: number;
	/** Over the heap after a GC before the first run. */
	peakHeap: number;
	heldHeap: number;
};

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Run with --expose-gc");

function heapAfterGc(): number {
	gc!();
	return process.memoryUsage().heapUsed;
}

const CHUNKS = 8;
/** Calls each inner `fan` makes at depth 2. */
const FAN_OUT = 10;

async function directorySize(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
	}
	return total;
}

async function open(backend: Backend, directory: string): Promise<Storage> {
	return backend === "sqlite"
		? openNodeSqliteStorage(join(directory, "session.sqlite"))
		: openNodeJsonlStorage(directory, context);
}

function noWrites(): Written {
	return {
		conversation: 0,
		entry: 0,
		task: 0,
		submission: 0,
		"document.create": 0,
		"document.copy": 0,
		"document.change": 0,
		"document.retire": 0,
	};
}

async function runScenario(scenario: Scenario): Promise<{ perRun: Run[]; closedBytes: number }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-nested-bench-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const chunk = `${"x".repeat(scenario.bytes / CHUNKS - 1)}\n`;
		// Streams its output and returns none, so its result is the retained output, as bash's is.
		const blob = defineTool({
			name: "blob",
			description: "Stream a blob",
			parameters: Type.Object({ n: Type.Number() }),
			execute: async (_args, api) => {
				for (let n = 0; n < CHUNKS; n++) {
					api.output(chunk);
					await new Promise((resolve) => setTimeout(resolve, scenario.gapMs));
				}
				return {};
			},
		});
		const options = scenario.progress ? {} : { progress: false as const };
		/** A tool that makes `count` parallel nested calls of `target`, which get `{ n, count: FAN_OUT }`. */
		const fanOut = (name: string, target: string) =>
			defineTool({
				name,
				description: `Call ${target} in parallel`,
				parameters: Type.Object({ count: Type.Number() }),
				execute: async (args, api, callContext) => {
					const calls = Array.from({ length: args.count }, (_, n) =>
						api.executeTool(target, { n, count: FAN_OUT }, callContext, options),
					);
					const failed = (await Promise.all(calls)).filter((result) => result.isError).length;
					return { output: [{ type: "text", text: `${failed} failed` }], isError: failed > 0 };
				},
			});
		registry.install(defineExtension({ name: "bench", tools: [blob, fanOut("fan", "blob"), fanOut("fan2", "fan")] }));

		const storage = await open(scenario.backend, directory);
		let commits = 0;
		const written = noWrites();
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, adopt, commitContext) => {
			commits++;
			for (const write of writes) written[write.type] += JSON.stringify(write).length;
			return commit(writes, adopt, commitContext);
		};
		const harness = await Harness.open(storage, { models, registry }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const perRun: Run[] = [];
		const top = scenario.depth === 1 ? scenario.calls : scenario.calls / FAN_OUT;
		const baseHeap = heapAfterGc();
		for (let run = 0; run < scenario.runs; run++) {
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall(scenario.depth === 1 ? "fan" : "fan2", { count: top }, { id: `r${run}` })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const before = { commits, written: { ...written } };
			let peakHeap = 0;
			const sampler = setInterval(() => {
				peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
			}, 5);
			const started = performance.now();
			const settled = await (await root.submit({ type: "input", content: `run ${run}` }, context)).wait(context);
			if (settled.status !== "done") throw new Error(`run ${run}: ${settled.status}`);
			await assertToolsSucceeded(root, run);
			await harness.waitForIdle(context);
			const ms = Math.round(performance.now() - started);
			clearInterval(sampler);
			const delta = noWrites();
			for (const type of Object.keys(delta) as StorageWrite["type"][]) {
				delta[type] = written[type] - before.written[type];
			}
			perRun.push({
				commits: commits - before.commits,
				written: delta,
				storedBytes: await directorySize(directory),
				ms,
				peakHeap: peakHeap - baseHeap,
				heldHeap: heapAfterGc() - baseHeap,
			});
		}
		await harness.close(context);
		return { perRun, closedBytes: await directorySize(directory) };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** A run that answers `done` may still have failed tools; the model-issued call's result says whether any did. */
async function assertToolsSucceeded(root: Conversation, run: number): Promise<void> {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0];
	if (result?.role !== "toolResult" || result.isError) throw new Error(`run ${run}: a nested call failed`);
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function report(title: string, scenarios: Scenario[]): Promise<void> {
	console.log(`\n${title}`);
	console.log(
		"backend | calls | depth | output | gap   | stream | run 1: commits, ms, written (all; tasks / doc changes / doc creates) | stored after run 1 / 2 / 3 | after close | heap: run 1 peak; held after run 1 / 2 / 3",
	);
	for (const scenario of scenarios) {
		const { perRun, closedBytes } = await runScenario(scenario);
		const first = perRun[0]!;
		const all = Object.values(first.written).reduce((sum, bytes) => sum + bytes, 0);
		console.log(
			[
				scenario.backend.padEnd(6),
				String(scenario.calls).padEnd(5),
				String(scenario.depth).padEnd(5),
				`${scenario.bytes / 1024} KiB`.padEnd(6),
				`${scenario.gapMs} ms`.padEnd(5),
				(scenario.progress ? "yes" : "no").padEnd(6),
				`${first.commits}, ${first.ms} ms, ${mib(all)} (${mib(first.written.task)} / ${mib(first.written["document.change"])} / ${mib(first.written["document.create"])})`,
				perRun.map((run) => mib(run.storedBytes)).join(" / "),
				mib(closedBytes),
				`${mib(first.peakHeap)}; ${perRun.map((run) => mib(run.heldHeap)).join(" / ")}`,
			].join(" | "),
		);
	}
}

async function main(): Promise<void> {
	const section = process.argv[2];
	if (section === undefined || section === "streaming") {
		const scenarios: Scenario[] = [];
		for (const backend of ["sqlite", "jsonl"] as const) {
			for (const bytes of [1024, 16 * 1024]) {
				for (const gapMs of [2, 50]) {
					for (const progress of [true, false]) {
						scenarios.push({ backend, calls: 200, depth: 1, bytes, gapMs, progress, runs: 3 });
					}
				}
			}
		}
		await report("Streaming: 200 calls, with and without progress", scenarios);
	}
	if (section === undefined || section === "nesting") {
		const scenarios: Scenario[] = [];
		for (const backend of ["sqlite", "jsonl"] as const) {
			for (const calls of [200, 2000]) {
				for (const depth of [1, 2] as const) {
					scenarios.push({ backend, calls, depth, bytes: 1024, gapMs: 2, progress: false, runs: 3 });
				}
			}
		}
		await report("Nesting: fast calls without progress, at depth 1 and 2", scenarios);
	}
}

await main();
