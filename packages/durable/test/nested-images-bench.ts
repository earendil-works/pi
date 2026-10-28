/**
 * Nested image storage benchmark. One model-issued `script` call, as a code mode call would, loops `count` times: a
 * nested `read_image` call returns a unique base64 image of `bytes` characters, then a nested `classify` call reads it.
 * The `inline` variant passes the image data in `classify`'s arguments; the `reference` variant passes the `taskId` of
 * the `read_image` result, whose value is the image, and `classify` resolves it from its caller's `NestedCallDoc`.
 * Reports commits, wall time, logical bytes written (JSON of the storage writes) by write type, the stored size before
 * `script` returns, after the run settles, after close, and after reopening, the heap (peak during the run, sampled
 * every 5 ms and at each commit; after a GC once the run settles, after `waitForIdle()`, and after reopening; all over
 * the heap after a GC before opening), the number of nested task records, and the size of the largest one.
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/nested-images-bench.ts [count]
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type JsonObject,
	NestedCallDoc,
	type Storage,
	type StorageWrite,
	type TaskId,
	ToolResultEntry,
	type ToolTaskInput,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

type Backend = "sqlite" | "jsonl";
type Variant = "inline" | "reference";
type Scenario = { backend: Backend; variant: Variant; count: number; bytes: number };
/** Hooks the tools call: a heap sample, and the stored size measured before `script` returns. */
type Probe = { sample: () => void; beforeReturn: () => Promise<void> };
type Written = Record<StorageWrite["type"], number>;
type Result = {
	commits: number;
	ms: number;
	written: Written;
	/** Before `script` returns, while its nested results are live. */
	storedLive: number;
	storedRun: number;
	storedClosed: number;
	storedReopened: number;
	/** Over the heap after a GC before opening. */
	peakHeap: number;
	settledHeap: number;
	idleHeap: number;
	reopenedHeap: number;
	nestedTasks: number;
	largestTask: number;
};

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Run with --expose-gc");

function heapAfterGc(): number {
	gc!();
	return process.memoryUsage().heapUsed;
}

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

const ImageArgument = Type.Object({
	type: Type.Literal("image"),
	mimeType: Type.String(),
	data: Type.Optional(Type.String()),
	source: Type.Optional(Type.Object({ taskId: Type.Number() })),
});

function registryFor(scenario: Scenario, probe: Probe) {
	const registry = createRegistry();
	const readImage = defineTool({
		name: "read_image",
		description: "Read an image",
		parameters: Type.Object({ n: Type.Number() }),
		// One image, so programs get it as an `ImageContent`. Unique per call: base64 of random bytes.
		execute: async () => ({
			output: [
				{ type: "image", data: randomBytes((scenario.bytes / 4) * 3).toString("base64"), mimeType: "image/png" },
			],
		}),
	});
	const classify = defineTool({
		name: "classify",
		description: "Classify images",
		parameters: Type.Object({ images: Type.Array(ImageArgument) }),
		execute: async (args, api, callContext) => {
			for (const image of args.images) {
				let data = image.data;
				if (image.source !== undefined) {
					// The caller is the nested call's `parent`; its `NestedCallDoc` holds the referenced result.
					const input = (await api.getTask(api.taskId, callContext))?.input as ToolTaskInput | undefined;
					if (input?.kind !== "nested") throw new Error("classify resolves references only as a nested call");
					// Results are keyed by call key, which the referenced call's input carries.
					const source = (await api.getTask(image.source.taskId as TaskId, callContext))?.input as ToolTaskInput;
					if (source.kind !== "nested") throw new Error("A reference names a nested call");
					const stored = await api.snapshot(NestedCallDoc, input.parent, source.key, callContext);
					const block = stored?.result?.structuredOutput as ImageContent | undefined;
					data = block?.type === "image" ? block.data : undefined;
				}
				if (data?.length !== scenario.bytes) throw new Error(`Image has ${data?.length} characters`);
			}
			return { output: [{ type: "text", text: "ok" }] };
		},
	});
	const script = defineTool({
		name: "script",
		description: "Read and classify images",
		parameters: Type.Object({ count: Type.Number() }),
		callers: ["model"],
		execute: async (args, api, callContext) => {
			for (let n = 0; n < args.count; n++) {
				const key = `read${n}`;
				const read = await api.executeTool("read_image", { n }, callContext, { key });
				const image = read.structuredOutput as unknown as ImageContent;
				const argument: JsonObject =
					scenario.variant === "inline"
						? { type: "image", data: image.data, mimeType: image.mimeType }
						: { type: "image", source: { taskId: read.taskId }, mimeType: image.mimeType };
				const classified = await api.executeTool("classify", { images: [argument] }, callContext, {
					key: `classify${n}`,
				});
				if (classified.isError) throw new Error(`classify ${n} failed: ${JSON.stringify(classified.diagnostics)}`);
				probe.sample();
			}
			await probe.beforeReturn();
			return { output: [{ type: "text", text: `classified ${args.count}` }] };
		},
	});
	registry.install(defineExtension({ name: "bench", tools: [readImage, classify, script] }));
	return registry;
}

async function runScenario(scenario: Scenario): Promise<Result> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-images-bench-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let peakHeap = 0;
		let storedLive = 0;
		const sample = () => {
			peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		};
		const registry = registryFor(scenario, {
			sample,
			beforeReturn: async () => {
				storedLive = await directorySize(directory);
			},
		});
		const baseHeap = heapAfterGc();

		const storage = await open(scenario.backend, directory);
		let commits = 0;
		const written = noWrites();
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, adopt, commitContext) => {
			commits++;
			// SQLite commits synchronously, which can starve the timer; sample here too.
			sample();
			for (const write of writes) written[write.type] += JSON.stringify(write).length;
			return commit(writes, adopt, commitContext);
		};
		const harness = await Harness.open(storage, { models, registry }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("script", { count: scenario.count }, { id: "s" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const before = { commits, written: { ...written } };
		peakHeap = 0;
		const sampler = setInterval(sample, 5);
		const started = performance.now();
		const settled = await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
		if (settled.status !== "done") throw new Error(`run: ${settled.status}`);
		// `done` only says the model answered; the script's result says whether it ran through.
		const latest = (await root.entries({}, 10, undefined, context)).items;
		const result = latest.find((entry) => ToolResultEntry.is(entry))?.model?.[0];
		if (result?.role !== "toolResult" || result.isError) throw new Error("run: the script failed");
		const ms = Math.round(performance.now() - started);
		clearInterval(sampler);
		const settledHeap = heapAfterGc() - baseHeap;
		await harness.waitForIdle(context);
		const idleHeap = heapAfterGc() - baseHeap;
		const delta = noWrites();
		for (const type of Object.keys(delta) as StorageWrite["type"][]) {
			delta[type] = written[type] - before.written[type];
		}
		const storedRun = await directorySize(directory);
		await harness.close(context);
		const storedClosed = await directorySize(directory);

		const reopenedStorage = await open(scenario.backend, directory);
		const reopened = await Harness.open(reopenedStorage, { models, registry }, context);
		const reopenedHeap = heapAfterGc() - baseHeap;
		const storedReopened = await directorySize(directory);
		let nestedTasks = 0;
		let largestTask = 0;
		let cursor: Parameters<Storage["scanTasks"]>[2];
		do {
			const page = await reopenedStorage.scanTasks({ kind: "pi.tool" }, 50, cursor, context);
			for (const record of page.items) {
				if ((record.input as ToolTaskInput).kind === "nested") nestedTasks++;
				largestTask = Math.max(largestTask, JSON.stringify(record).length);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		await reopened.close(context);
		return {
			commits: commits - before.commits,
			ms,
			written: delta,
			storedLive,
			storedRun,
			storedClosed,
			storedReopened,
			peakHeap: peakHeap - baseHeap,
			settledHeap,
			idleHeap,
			reopenedHeap,
			nestedTasks,
			largestTask,
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main(): Promise<void> {
	const counts = process.argv[2] === undefined ? [50, 200] : [Number(process.argv[2])];
	const bytes = 1024 * 1024;
	console.log(`Images: ${bytes / 1024} KiB base64 each, read then classified sequentially in one script call`);
	console.log(
		"backend | variant   | count | commits, ms | written: all (task / doc create / doc change / entry) | stored: live / run / closed / reopened | heap: peak; settled / idle / reopened | nested tasks, largest task",
	);
	for (const count of counts) {
		for (const backend of ["sqlite", "jsonl"] as const) {
			for (const variant of ["inline", "reference"] as const) {
				const result = await runScenario({ backend, variant, count, bytes });
				const all = Object.values(result.written).reduce((sum, value) => sum + value, 0);
				const written = result.written;
				console.log(
					[
						backend.padEnd(7),
						variant.padEnd(9),
						String(count).padEnd(5),
						`${result.commits}, ${result.ms} ms`,
						`${mib(all)} (${mib(written.task)} / ${mib(written["document.create"])} / ${mib(written["document.change"])} / ${mib(written.entry)})`,
						`${mib(result.storedLive)} / ${mib(result.storedRun)} / ${mib(result.storedClosed)} / ${mib(result.storedReopened)}`,
						`${mib(result.peakHeap)}; ${mib(result.settledHeap)} / ${mib(result.idleHeap)} / ${mib(result.reopenedHeap)}`,
						`${result.nestedTasks}, ${kib(result.largestTask)}`,
					].join(" | "),
				);
			}
		}
	}
}

await main();
