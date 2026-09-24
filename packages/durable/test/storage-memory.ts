import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	STORAGE_MEMORY_SCALES,
	STORAGE_READ_BENCHMARKS,
	type StorageBenchmarkScale,
	seedStorageBenchmark,
	storageBenchmarkPrimaryRecordCount,
} from "@earendil-works/pi-durable/testing";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { Storage } from "../src/types.ts";

const STORAGE_BENCHMARK_BACKENDS = ["memory", "sqlite", "jsonl"] as const;
type StorageBenchmarkBackend = (typeof STORAGE_BENCHMARK_BACKENDS)[number];

type MemorySnapshot = {
	readonly heapUsed: number;
	readonly rss: number;
	readonly external: number;
};

type DiskFootprint =
	| {
			readonly kind: "sqlite";
			readonly mainBytes: number;
			readonly auxiliaryBytes: number;
			readonly fileCount: number;
			readonly pageCount: number;
			readonly freelistCount: number;
	  }
	| {
			readonly kind: "jsonl";
			readonly mainBytes: number;
			readonly auxiliaryBytes: number;
			readonly fileCount: number;
			readonly documentFiles: number;
			readonly taskFiles: number;
	  };

type StorageMemoryResult = {
	readonly backend: StorageBenchmarkBackend;
	readonly scale: string;
	readonly recordCount: number;
	readonly baseline: MemorySnapshot;
	readonly postSeed: MemorySnapshot;
	readonly postRead: MemorySnapshot;
	readonly disk?: DiskFootprint;
};

const execFileAsync = promisify(execFile);

function collectGarbage(): void {
	if (globalThis.gc === undefined) throw new Error("Storage memory measurement requires Node.js --expose-gc");
	for (let index = 0; index < 3; index++) globalThis.gc();
}

function snapshot(): MemorySnapshot {
	const usage = process.memoryUsage();
	return { heapUsed: usage.heapUsed, rss: usage.rss, external: usage.external };
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function sqliteMetrics(path: string): Extract<DiskFootprint, { readonly kind: "sqlite" }> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const pageCount = database.prepare("SELECT page_count AS value FROM pragma_page_count()").get() as {
			readonly value: number;
		};
		const freelistCount = database.prepare("SELECT freelist_count AS value FROM pragma_freelist_count()").get() as {
			readonly value: number;
		};
		return {
			kind: "sqlite",
			mainBytes: 0,
			auxiliaryBytes: 0,
			fileCount: 0,
			pageCount: pageCount.value,
			freelistCount: freelistCount.value,
		};
	} finally {
		database.close();
	}
}

async function jsonlMetrics(directory: string): Promise<Extract<DiskFootprint, { readonly kind: "jsonl" }>> {
	const entries = await readdir(directory, { withFileTypes: true });
	let mainBytes = 0;
	let auxiliaryBytes = 0;
	let fileCount = 0;
	let documentFiles = 0;
	let taskFiles = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const bytes = await fileSize(join(directory, entry.name));
		fileCount++;
		if (entry.name === "main.jsonl") mainBytes += bytes;
		else auxiliaryBytes += bytes;
		if (entry.name.startsWith("doc-") && entry.name.endsWith(".jsonl")) documentFiles++;
		if (entry.name.startsWith("task-") && entry.name.endsWith(".jsonl")) taskFiles++;
	}
	return { kind: "jsonl", mainBytes, auxiliaryBytes, fileCount, documentFiles, taskFiles };
}

async function runWorker(backend: StorageBenchmarkBackend, scale: StorageBenchmarkScale): Promise<void> {
	let storage: Storage;
	let directory: string | undefined;
	let path: string | undefined;
	if (backend === "memory") {
		storage = new MemoryStorage();
	} else {
		directory = await mkdtemp(join(tmpdir(), `pi-durable-${backend}-memory-`));
		path = join(directory, backend === "sqlite" ? "storage.sqlite" : "storage");
		storage =
			backend === "sqlite"
				? await openNodeSqliteStorage(path)
				: await openNodeJsonlStorage(path, BACKGROUND_CONTEXT);
	}

	try {
		collectGarbage();
		const baseline = snapshot();
		const dataset = await seedStorageBenchmark(storage, scale);
		collectGarbage();
		const postSeed = snapshot();
		let checksum = 0;
		for (const scenario of STORAGE_READ_BENCHMARKS) {
			const result = await scenario.run(storage, dataset);
			if (result !== scenario.expected(dataset)) throw new Error(`Invalid benchmark result: ${scenario.name}`);
			checksum += result;
		}
		for (let round = 1; round < 10; round++) {
			for (const scenario of STORAGE_READ_BENCHMARKS) checksum += await scenario.run(storage, dataset);
		}
		if (!Number.isFinite(checksum)) throw new Error("Storage memory read checksum is invalid");
		collectGarbage();
		const postRead = snapshot();
		let disk: DiskFootprint | undefined;
		if (path !== undefined && backend === "sqlite") {
			disk = {
				...sqliteMetrics(path),
				mainBytes: await fileSize(path),
				auxiliaryBytes: (await fileSize(`${path}-wal`)) + (await fileSize(`${path}-shm`)),
				fileCount: 3,
			};
		} else if (path !== undefined) {
			disk = await jsonlMetrics(path);
		}
		const recordCount = storageBenchmarkPrimaryRecordCount(scale);
		console.log(JSON.stringify({ backend, scale: scale.name, recordCount, baseline, postSeed, postRead, disk }));
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
		if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	}
}

function delta(after: MemorySnapshot, before: MemorySnapshot, field: keyof MemorySnapshot): number {
	return after[field] - before[field];
}

function mebibytes(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

async function runDriver(): Promise<void> {
	const workerPath = fileURLToPath(import.meta.url);
	const results: StorageMemoryResult[] = [];
	for (const backend of STORAGE_BENCHMARK_BACKENDS) {
		for (const scale of STORAGE_MEMORY_SCALES) {
			const { stdout } = await execFileAsync(
				process.execPath,
				[
					"--conditions=source",
					"--expose-gc",
					"--experimental-strip-types",
					workerPath,
					"--worker",
					backend,
					scale.name,
				],
				{ cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 },
			);
			results.push(JSON.parse(stdout) as StorageMemoryResult);
		}
	}

	console.log("Storage footprint after deterministic synthetic workloads; values are process deltas, not limits.");
	console.table(
		results.map((result) => ({
			backend: result.backend,
			scale: result.scale,
			"heap after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "heapUsed")),
			"RSS after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "rss")),
			"external after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "external")),
			"heap after reads MiB": mebibytes(delta(result.postRead, result.postSeed, "heapUsed")),
			"JS heap bytes/primary record": Math.round(
				delta(result.postSeed, result.baseline, "heapUsed") / result.recordCount,
			),
			"disk main MiB": result.disk === undefined ? "-" : mebibytes(result.disk.mainBytes),
			"disk auxiliary MiB": result.disk === undefined ? "-" : mebibytes(result.disk.auxiliaryBytes),
			"disk total MiB":
				result.disk === undefined ? "-" : mebibytes(result.disk.mainBytes + result.disk.auxiliaryBytes),
			"disk files": result.disk?.fileCount ?? "-",
			"disk detail":
				result.disk === undefined
					? "-"
					: result.disk.kind === "sqlite"
						? `pages/free ${result.disk.pageCount}/${result.disk.freelistCount}`
						: `documents/tasks ${result.disk.documentFiles}/${result.disk.taskFiles}`,
		})),
	);
}

const [mode, backendName, scaleName] = process.argv.slice(2);
if (mode === "--worker") {
	const backend = STORAGE_BENCHMARK_BACKENDS.find((candidate) => candidate === backendName);
	if (backend === undefined) throw new Error(`Unknown storage benchmark backend: ${backendName}`);
	const scale = STORAGE_MEMORY_SCALES.find((candidate) => candidate.name === scaleName);
	if (scale === undefined) throw new Error(`Unknown storage benchmark scale: ${scaleName}`);
	await runWorker(backend, scale);
} else {
	await runDriver();
}
