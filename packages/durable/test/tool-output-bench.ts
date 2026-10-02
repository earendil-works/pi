/**
 * Tool output benchmark: drives the real tool task, adaptive progress throttle, and `pi.live` commits.
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/tool-output-bench.ts
 *
 * Each scenario runs in its own child process so peak RSS is its own. Rate scenarios write output for a fixed time,
 * then close the Harness mid-round (persistent backends) to measure replay of the round's delta chain on reopen, and
 * finish the run to measure the stored size after the round's base and reclamation. Throughput scenarios push 1 GiB.
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createRegistry, defineTool, Harness, LiveDoc, MemoryStorage, type Storage } from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { createBashTool } from "../src/tools/index.ts";
import { addTool } from "./harness-support.ts";

type Backend = "memory" | "sqlite" | "jsonl";
type Rate = "low" | "normal" | "high";
type Scenario =
	| { kind: "rate"; backend: Backend; rate: Rate; retain: "head" | "tail"; tools: number; seconds?: number }
	| { kind: "firehose"; backend: Backend; retain: "head" | "tail"; repetitive?: boolean }
	| { kind: "cat"; backend: Backend };

const RATE_SECONDS = 3;
const GIB = 1 << 30;
const LINE = "The quick brown fox jumps over the lazy dog. Unique identifier";
const BIG_FILE = join(tmpdir(), "pi-durable-bench-1gib.txt");

/** Output one tool writes per tick, and the pause between ticks. */
const RATES: Record<Rate, { readonly lines: number; readonly pauseMs: number }> = {
	// A line every 200 ms, like a slow build step.
	low: { lines: 1, pauseMs: 200 },
	// Bursts of 25 lines every 50 ms (~40 KB/s), like a compiler or test run.
	normal: { lines: 25, pauseMs: 50 },
	// Continuous 64 KiB chunks, yielding to the event loop between them.
	high: { lines: 800, pauseMs: 0 },
};

async function main(): Promise<void> {
	const [, , encoded] = process.argv;
	if (encoded !== undefined) {
		const result = await runScenario(JSON.parse(encoded) as Scenario);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	const scenarios: Scenario[] = [];
	for (const backend of ["memory", "sqlite", "jsonl"] as const) {
		for (const rate of ["low", "normal", "high"] as const) {
			for (const retain of ["head", "tail"] as const) {
				for (const tools of [1, 4]) scenarios.push({ kind: "rate", backend, rate, retain, tools });
			}
		}
		for (const retain of ["head", "tail"] as const) scenarios.push({ kind: "firehose", backend, retain });
		// Identical lines: how often Chord's bounded overlap search falls back to writing the whole tail window.
		scenarios.push({ kind: "firehose", backend, retain: "tail", repetitive: true });
		// One long round: the delta chain a chatty tail tool builds before the round's base.
		if (backend !== "memory")
			scenarios.push({ kind: "rate", backend, rate: "high", retain: "tail", tools: 1, seconds: 30 });
		scenarios.push({ kind: "cat", backend });
	}
	await ensureBigFile();
	const rows: Record<string, unknown>[] = [];
	for (const scenario of scenarios) {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[...process.execArgv, fileURLToPath(import.meta.url), JSON.stringify(scenario)],
			{ maxBuffer: 1 << 20 },
		);
		rows.push({ ...label(scenario), ...JSON.parse(stdout.trim().split("\n").at(-1)!) });
	}
	console.table(rows);
}

function label(scenario: Scenario): Record<string, unknown> {
	if (scenario.kind === "rate") {
		const { backend, rate, retain, tools, seconds } = scenario;
		return { scenario: `${rate} ${retain} x${tools}${seconds === undefined ? "" : ` ${seconds}s`}`, backend };
	}
	if (scenario.kind === "cat") return { scenario: "bash cat 1 GiB", backend: scenario.backend };
	const repetitive = scenario.repetitive === true ? " repetitive" : "";
	return { scenario: `api.output 1 GiB ${scenario.retain}${repetitive}`, backend: scenario.backend };
}

async function ensureBigFile(): Promise<void> {
	if ((await stat(BIG_FILE).catch(() => undefined))?.size === GIB) return;
	// Unique lines, written in 64 MiB blocks and cut at exactly 1 GiB.
	const file = await open(BIG_FILE, "w");
	try {
		let index = 0;
		for (let written = 0; written < GIB; ) {
			let block = "";
			while (block.length < 64 << 20) block += `Line ${index++}: ${LINE}: ${(index * 7919).toString(16)}\n`;
			const bytes = Buffer.from(block).subarray(0, GIB - written);
			await file.write(bytes);
			written += bytes.length;
		}
	} finally {
		await file.close();
	}
}

type Metrics = {
	ms: number;
	liveCommits: number;
	liveOpKiB: number;
	/** Output writes recorded as a whole-string set, including each slot's first write; the rest are appends/trims. */
	outputSets: number;
	commitP50Ms: number;
	commitP99Ms: number;
	midRoundKiB?: number;
	replayMs?: number;
	finalKiB?: number;
	peakRssMiB: number;
	heapAfterGcMiB?: number;
};

async function runScenario(scenario: Scenario): Promise<Metrics> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-bench-"));
	try {
		const path = join(directory, scenario.backend === "sqlite" ? "session.sqlite" : "session");
		const latencies: number[] = [];
		const openTimed = async (): Promise<Storage> => timed(await openStorage(scenario.backend, path), latencies);
		let stop = false;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const toolCount = scenario.kind === "rate" ? scenario.tools : 1;
		if (scenario.kind === "cat") {
			addTool(registry, createBashTool());
		} else {
			const rate = scenario.kind === "rate" ? RATES[scenario.rate] : RATES.high;
			addTool(
				registry,
				defineTool({
					name: "emit",
					description: "",
					parameters: Type.Object({}),
					outputLimits: { retain: scenario.retain },
					execute: async (_args, api, callContext) => {
						let counter = 0;
						let written = 0;
						// The firehose reuses one prebuilt chunk so it measures the Harness, not string building.
						const prebuilt = scenario.kind === "firehose" ? lines(api.callId, 0, rate.lines) : undefined;
						// Repetitive: identical lines with one numbered line per chunk, so the tail window keeps sliding.
						const repeated = "y\n".repeat(32 * 1024 - 8);
						while (!stop && (scenario.kind === "rate" || written < GIB)) {
							const chunk =
								scenario.kind === "firehose" && scenario.repetitive === true
									? `${repeated}#${counter}\n`
									: (prebuilt ?? lines(api.callId, counter, rate.lines));
							counter += rate.lines;
							api.output(chunk);
							written += chunk.length;
							await new Promise((resolve) =>
								rate.pauseMs === 0 ? setImmediate(resolve) : setTimeout(resolve, rate.pauseMs),
							);
						}
						// A persistent rate scenario stays in flight until close, so reopen replays the round.
						if (scenario.kind === "rate" && scenario.backend !== "memory") {
							await new Promise((_, reject) =>
								callContext.abortSignal!.addEventListener("abort", () =>
									reject(callContext.abortSignal!.reason),
								),
							);
						}
						return {};
					},
				}),
			);
		}
		const call =
			scenario.kind === "cat"
				? [fauxToolCall("bash", { command: `cat ${BIG_FILE}` }, { id: "c0" })]
				: Array.from({ length: toolCount }, (_, index) => fauxToolCall("emit", {}, { id: `c${index}` }));
		faux.setResponses([
			fauxAssistantMessage(call, { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const nodeEnv = new NodeExecutionEnv({ cwd: directory });
		const env = () => nodeEnv;
		let harness = await Harness.open(await openTimed(), { models, registry, env }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		let liveCommits = 0;
		let liveOpBytes = 0;
		let outputSets = 0;
		const observe = (target: Harness): void => {
			target.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					if (change.type !== "document" || change.record.kind !== "pi.live") continue;
					liveCommits++;
					liveOpBytes += JSON.stringify(change.ops).length;
					for (const op of change.ops) if (op[0] === "s" && op[1].at(-1) === "output") outputSets++;
				}
			});
		};
		observe(harness);
		const started = performance.now();
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const metrics: Partial<Metrics> = {};
		if (scenario.kind === "rate") {
			await new Promise((resolve) => setTimeout(resolve, (scenario.seconds ?? RATE_SECONDS) * 1000));
			stop = true;
			if (scenario.backend !== "memory") {
				// Let the last progress commit land, then close mid-round and time replay on reopen.
				await new Promise((resolve) => setTimeout(resolve, 600));
				metrics.midRoundKiB = await footprint(scenario.backend, path);
				await harness.close(context);
				const reopened = performance.now();
				harness = await Harness.open(await openTimed(), { models, registry, env }, context);
				await harness.snapshot(LiveDoc, root.id, context);
				observe(harness);
				metrics.replayMs = Math.round(performance.now() - reopened);
				harness.resume();
				await (await harness.submission(submission.id, context))!.wait(context);
			} else {
				await submission.wait(context);
			}
		} else {
			await submission.wait(context);
		}
		const ms = Math.round(performance.now() - started);
		if (scenario.backend !== "memory") metrics.finalKiB = await footprint(scenario.backend, path);
		await harness.close(context);
		latencies.sort((a, b) => a - b);
		const gc = (globalThis as { gc?: () => void }).gc;
		gc?.();
		return {
			ms,
			liveCommits,
			liveOpKiB: Math.round(liveOpBytes / 1024),
			outputSets,
			commitP50Ms: round(latencies[Math.floor(latencies.length * 0.5)] ?? 0),
			commitP99Ms: round(latencies[Math.floor(latencies.length * 0.99)] ?? 0),
			...metrics,
			peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
			heapAfterGcMiB: gc === undefined ? undefined : Math.round(process.memoryUsage().heapUsed / 2 ** 20),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function openStorage(backend: Backend, path: string): Promise<Storage> {
	if (backend === "memory") return new MemoryStorage();
	if (backend === "sqlite") return openNodeSqliteStorage(path);
	return openNodeJsonlStorage(path, context);
}

/** Measure every Storage commit. */
function timed(storage: Storage, latencies: number[]): Storage {
	return new Proxy(storage, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "commit" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: unknown[]) => {
				const start = performance.now();
				try {
					return await value.apply(target, args);
				} finally {
					latencies.push(performance.now() - start);
				}
			};
		},
	});
}

async function footprint(backend: Backend, path: string): Promise<number> {
	if (backend === "sqlite") {
		let bytes = 0;
		for (const suffix of ["", "-wal", "-shm"]) bytes += (await stat(path + suffix).catch(() => undefined))?.size ?? 0;
		return Math.round(bytes / 1024);
	}
	let bytes = 0;
	for (const file of await readdir(path)) bytes += (await stat(join(path, file))).size;
	return Math.round(bytes / 1024);
}

function lines(prefix: string, first: number, count: number): string {
	let text = "";
	for (let index = first; index < first + count; index++) text += `${prefix} ${index}: ${LINE}\n`;
	return text;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

await main();
