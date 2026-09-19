/** Cold/full traversal complements the hot-access and replication benchmarks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { track } from "../src/delta/index.ts";

type Point = { x: number; y: number; pressure: number };
type Drawing = { strokes: { id: number; color: string; width: number; points: Point[] }[] };
type Mode = "raw" | "proxy" | "delta";
const MiB = 1024 * 1024;
async function gc(): Promise<void> {
	if (!global.gc) throw new Error("run with --expose-gc");
	// WeakRef targets survive their current job. Allow both target collection
	// and finalizer cleanup in subsequent jobs before sampling retained memory.
	for (let i = 0; i < 4; i++) {
		await setImmediate();
		global.gc();
	}
	await setImmediate();
}

function fixture(strokes: number, points: number): Drawing {
	return {
		strokes: Array.from({ length: strokes }, (_, id) => ({
			id,
			color: id % 2 ? "#405060" : "#102030",
			width: 2,
			points: Array.from({ length: points }, (_, p) => ({
				x: p * 3 + (id % 127),
				y: p * 7 + (id % 131),
				pressure: (p % 10) / 10,
			})),
		})),
	};
}
function membrane<T extends object>(input: T): T {
	const cache = new WeakMap<object, object>();
	const wrap = (value: object): object => {
		const existing = cache.get(value);
		if (existing) return existing;
		const proxy = new Proxy(value, {
			get(target, key, receiver) {
				const child: unknown = Reflect.get(target, key, receiver);
				return child !== null && typeof child === "object" ? wrap(child) : child;
			},
		});
		cache.set(value, proxy);
		return proxy;
	};
	return wrap(input) as T;
}
function setup(mode: Mode, input: Drawing): { state: Drawing; flush(): unknown } {
	if (mode === "delta") {
		const t = track(input);
		return { state: t.state, flush: () => t.flush() };
	}
	return { state: mode === "proxy" ? membrane(input) : input, flush: () => null };
}
// Keep temporary raw inputs and initial wire batches out of the measuring frame.
function prepare(mode: Mode, strokes: number, points: number) {
	const t = setup(mode, fixture(strokes, points));
	t.flush();
	return t;
}
function traverse(state: Drawing): number {
	let sum = 0;
	const strokes = state.strokes;
	for (let s = 0; s < strokes.length; s++) {
		const points = strokes[s].points;
		for (let p = 0; p < points.length; p++) {
			const point = points[p];
			sum += point.x + point.y + point.pressure;
		}
	}
	return sum;
}
function warm(mode: Mode): void {
	const t = prepare(mode, 10, 10);
	for (let i = 0; i < 10; i++) traverse(t.state);
}
function sources() {
	return Object.fromEntries(
		["../src/delta/index.ts", "./delta-traversal.bench.ts"].map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(new URL(path, import.meta.url)))
				.digest("hex"),
		]),
	);
}
async function measure(mode: Mode, strokes: number, points: number, trial: number) {
	warm(mode);
	await gc();
	const empty = process.memoryUsage().heapUsed;
	const t = prepare(mode, strokes, points);
	await gc();
	const ready = process.memoryUsage().heapUsed;
	const start = performance.now();
	const checksum = traverse(t.state);
	const coldMs = performance.now() - start;
	const afterColdBeforeGc = process.memoryUsage().heapUsed;
	await gc();
	const afterCold = process.memoryUsage().heapUsed;
	const warmMs: number[] = [];
	for (let i = 0; i < 3; i++) {
		const begin = performance.now();
		const check = traverse(t.state);
		warmMs.push(performance.now() - begin);
		assert.equal(check, checksum);
	}
	let expected = 0;
	for (let s = 0; s < strokes; s++) {
		for (let p = 0; p < points; p++) expected += p * 10 + (s % 127) + (s % 131) + (p % 10) / 10;
	}
	assert.ok(Math.abs(expected - checksum) < Math.max(1, Math.abs(expected)) * 1e-9);
	await gc();
	const retained = process.memoryUsage().heapUsed;
	assert.equal(t.state.strokes.length, strokes);
	return {
		mode,
		strokes,
		points,
		trial,
		coldMs,
		warmMs,
		checksum,
		readyMiB: (ready - empty) / MiB,
		afterColdMiB: (afterCold - empty) / MiB,
		retainedMiB: (retained - empty) / MiB,
		lazyProxyMiB: (afterCold - ready) / MiB,
		sampledColdPeakMiB: (afterColdBeforeGc - empty) / MiB,
		maxRssMiB: process.resourceUsage().maxRSS / 1024,
		sourceHashes: sources(),
	};
}
if (process.argv.includes("--worker")) {
	const c = JSON.parse(process.argv.at(-1)!) as { mode: Mode; strokes: number; points: number; trial: number };
	console.log(JSON.stringify(await measure(c.mode, c.strokes, c.points, c.trial)));
} else {
	const quick = process.argv.includes("--quick");
	const outIndex = process.argv.indexOf("--out");
	const output = outIndex < 0 ? "/tmp/delta-traversal.json" : process.argv[outIndex + 1];
	const modeIndex = process.argv.indexOf("--modes");
	const selected = new Set(modeIndex < 0 ? ["raw", "proxy", "delta"] : process.argv[modeIndex + 1].split(","));
	for (const mode of selected) if (!["raw", "proxy", "delta"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
	const hashes = sources();
	const results: Awaited<ReturnType<typeof measure>>[] = [];
	const failures: unknown[] = [];
	for (let trial = 0; trial < (quick ? 1 : 3); trial++) {
		const modes: Mode[] = trial % 2 ? ["delta", "proxy", "raw"] : ["raw", "proxy", "delta"];
		for (const mode of modes) {
			if (!selected.has(mode)) continue;
			assert.deepStrictEqual(sources(), hashes, "source changed during benchmark");
			const config = { mode, strokes: quick ? 200 : 20000, points: 100, trial };
			const child = spawnSync(
				process.execPath,
				[
					"--expose-gc",
					"--max-old-space-size=8192",
					fileURLToPath(import.meta.url),
					"--worker",
					JSON.stringify(config),
				],
				{ encoding: "utf8", timeout: 180000, maxBuffer: 5 * MiB },
			);
			assert.deepStrictEqual(sources(), hashes, "source changed during benchmark");
			if (child.status !== 0)
				failures.push({ config, error: String(child.error ?? ""), stderr: child.stderr, stdout: child.stdout });
			else results.push(JSON.parse(child.stdout));
			writeFileSync(
				output,
				JSON.stringify(
					{ node: process.version, date: new Date().toISOString(), sourceHashes: hashes, results, failures },
					null,
					2,
				),
			);
			console.log(`${trial} ${mode}: ${child.status === 0 ? "ok" : "FAILED"}`);
		}
	}
	console.log(`Results: ${output}; failures: ${failures.length}`);
	if (failures.length) process.exitCode = 1;
}
