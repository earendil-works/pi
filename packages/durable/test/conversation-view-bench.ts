/**
 * Conversation view benchmark: a long conversation (thousands of entries) and the watches of its view.
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/conversation-view-bench.ts
 *
 * Scenarios, each in its own child process so heap numbers are its own, on SQLite so history stays out of the heap
 * (`SqliteStorage`; with `PI_DURABLE_BENCH_STORAGE=store`, Durable's storage on Chord's store, `StoreStorage`):
 * - `start`: acquire a watch of a conversation of N entries (the mount is built every time; the watch is stopped).
 * - `append`: K started watches; commit entries one per commit, or in bursts of 50 per commit, and wait for delivery.
 * - `resume`: a watch with `from` 20 entries back, as a client that reconnects after a short drop.
 * - `stream`: K started watches; commits that change only `pi.live` (a streamed answer), no entries.
 * - `long-lived`: one started watch while 20,000 entries are appended; heap after GC, and whether the first entry
 *   delivered is still reachable.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, createRegistry, type EntryId, Harness, LiveDoc, type Storage } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { openStoreStorage } from "./store-storage-support.ts";

type Scenario =
	| { kind: "start"; entries: number }
	| { kind: "append"; entries: number; watches: number; burst: number; commits: number }
	| { kind: "resume"; entries: number }
	| { kind: "stream"; entries: number; watches: number; commits: number }
	| { kind: "long-lived"; entries: number };

const TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(10);
type Watch = Awaited<ReturnType<Conversation["watch"]>>;
/** `watch(context, options)`; an older Harness ignores the options. */
type WatchWith = (context: Context, options?: { from?: EntryId }) => Promise<Watch>;

async function main(): Promise<void> {
	const [, , encoded] = process.argv;
	if (encoded !== undefined) {
		const result = await run(JSON.parse(encoded) as Scenario);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	const scenarios: Scenario[] = [
		{ kind: "start", entries: 5000 },
		{ kind: "resume", entries: 5000 },
		{ kind: "append", entries: 5000, watches: 1, burst: 1, commits: 2000 },
		{ kind: "append", entries: 5000, watches: 4, burst: 1, commits: 2000 },
		{ kind: "append", entries: 5000, watches: 4, burst: 50, commits: 200 },
		{ kind: "stream", entries: 5000, watches: 4, commits: 5000 },
		{ kind: "long-lived", entries: 20000 },
	];
	const rows: Record<string, unknown>[] = [];
	for (const scenario of scenarios) {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[...process.execArgv, fileURLToPath(import.meta.url), JSON.stringify(scenario)],
			{ maxBuffer: 1 << 20 },
		);
		rows.push({ scenario: label(scenario), ...JSON.parse(stdout.trim().split("\n").at(-1)!) });
	}
	console.table(rows);
}

function label(scenario: Scenario): string {
	switch (scenario.kind) {
		case "start":
			return `watch start, ${scenario.entries} entries`;
		case "resume":
			return `resume 20 back, ${scenario.entries} entries`;
		case "append":
			return `append x${scenario.burst} per commit, ${scenario.watches} watches`;
		case "stream":
			return `pi.live only, ${scenario.watches} watches`;
		case "long-lived":
			return `long-lived watch, ${scenario.entries} appends`;
	}
}

function gc(): void {
	(globalThis as { gc?: () => void }).gc?.();
}

function heapMiB(): number {
	gc();
	gc();
	return Math.round((process.memoryUsage().heapUsed / 2 ** 20) * 10) / 10;
}

async function appendEntries(conversation: Conversation, count: number, perCommit: number): Promise<void> {
	for (let done = 0; done < count; done += perCommit) {
		await conversation.commit(async (tx) => {
			for (let index = done; index < Math.min(count, done + perCommit); index++) {
				await tx.appendEntry(conversation.id, { kind: "note", data: { text: `${index} ${TEXT}` } });
			}
		}, context);
	}
}

/** Resolve once every watch delivered a value whose newest entry is `id`. */
function delivered(watches: readonly Watch[], id: () => EntryId | undefined): Promise<void> {
	return new Promise((resolve) => {
		const check = (): void => {
			const target = id();
			if (watches.every((watch) => watch.value.entries.at(-1)?.id === target)) resolve();
			else setTimeout(check, 1);
		};
		check();
	});
}

async function run(scenario: Scenario): Promise<Record<string, number>> {
	const directory = mkdtempSync(join(tmpdir(), "pi-durable-view-bench-"));
	let storage: Storage | undefined;
	try {
		const path = join(directory, "session.sqlite");
		storage =
			process.env.PI_DURABLE_BENCH_STORAGE === "store"
				? await openStoreStorage(path)
				: await openNodeSqliteStorage(path);
		const models = createModels();
		const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
		const root = await harness.root(context);
		await appendEntries(root, scenario.entries, 500);
		const newest = async (): Promise<EntryId> => (await root.entries({}, 1, undefined, context)).items[0]!.id;
		const watchWith = root.watch.bind(root) as unknown as WatchWith;
		const heapBefore = heapMiB();
		const cpu = process.cpuUsage();
		const started = performance.now();
		const result: Record<string, number> = {};
		if (scenario.kind === "start" || scenario.kind === "resume") {
			const from = scenario.kind === "resume" ? (((await newest()) - 19) as EntryId) : undefined;
			const times: number[] = [];
			let size = 0;
			for (let round = 0; round < 20; round++) {
				const at = performance.now();
				const watch = await watchWith(context, from === undefined ? undefined : { from });
				times.push(performance.now() - at);
				size = watch.value.entries.length;
				await watch.stop();
			}
			times.sort((a, b) => a - b);
			result.p50Ms = round(times[10]!);
			result.windowEntries = size;
		} else if (scenario.kind === "append") {
			const watches = await Promise.all(Array.from({ length: scenario.watches }, () => root.watch(context)));
			for (const watch of watches) watch.start(async () => {});
			let last: EntryId | undefined;
			const at = performance.now();
			for (let index = 0; index < scenario.commits; index++) {
				const ids = await root.commit(async (tx) => {
					const appended: EntryId[] = [];
					for (let n = 0; n < scenario.burst; n++) {
						appended.push((await tx.appendEntry(root.id, { kind: "note", data: { text: TEXT } })).id);
					}
					return appended;
				}, context);
				last = ids.at(-1);
			}
			await delivered(watches, () => last);
			result.perCommitUs = round(((performance.now() - at) * 1000) / scenario.commits);
			result.windowEntries = watches[0]!.value.entries.length;
			result.heapWithWatchesMiB = heapMiB();
			for (const watch of watches) await watch.stop();
		} else if (scenario.kind === "stream") {
			const watches = await Promise.all(Array.from({ length: scenario.watches }, () => root.watch(context)));
			let calls = 0;
			for (const watch of watches)
				watch.start(async () => {
					calls++;
				});
			const at = performance.now();
			for (let index = 0; index < scenario.commits; index++) {
				await root.commit(async (tx) => {
					(await tx.doc(LiveDoc, root.id)).compactionFailure = {
						taskId: 1 as never,
						trigger: "manual",
						error: `${index}`,
					};
				}, context);
			}
			// Every watch delivered the final value, not just one of them.
			const last = `${scenario.commits - 1}`;
			const done = () =>
				watches.every(
					(watch) =>
						(watch.value.docs["pi.live"] as { compactionFailure?: { error: string } } | undefined)
							?.compactionFailure?.error === last,
				);
			while (calls < scenario.watches || !done()) await new Promise((resolve) => setTimeout(resolve, 1));
			result.perCommitUs = round(((performance.now() - at) * 1000) / scenario.commits);
			for (const watch of watches) await watch.stop();
		} else {
			const watch = await root.watch(context);
			let first: WeakRef<object> | undefined;
			watch.start(async (call) => {
				if (call.kind !== "value") return;
				const entry = call.value.entries.at(-1);
				if (first === undefined && entry !== undefined) first = new WeakRef(entry);
			});
			await appendEntries(root, 1, 1);
			const id = await newest();
			await delivered([watch], () => id);
			await appendEntries(root, scenario.entries, 1);
			const last = await newest();
			await delivered([watch], () => last);
			result.windowEntries = watch.value.entries.length;
			result.heapWithWatchMiB = heapMiB();
			// A WeakRef's target survives the job that created or read it; collect again in a later task.
			await new Promise((resolve) => setTimeout(resolve, 10));
			gc();
			result.firstEntryCollected = first?.deref() === undefined ? 1 : 0;
			await watch.stop();
		}
		const usage = process.cpuUsage(cpu);
		result.cpuMs = round((usage.user + usage.system) / 1000);
		result.wallMs = round(performance.now() - started);
		result.heapBeforeMiB = heapBefore;
		await harness.close(context);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

await main();
