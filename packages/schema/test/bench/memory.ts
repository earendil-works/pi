// Retained heap of 3,200 distinct compiled schemas per candidate. Each candidate runs in its own process with
// --expose-gc: the schemas and values are built before the baseline, every library's returned validator is kept,
// and the heap is read after forced collections, once after compiling and once after checking each value 3 times
// (when libraries that compile lazily, like omptype, have compiled).
// Run: node test/bench/memory.ts [--json <file>]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { byName, candidates } from "./candidates.ts";
import { corpus } from "./corpus.ts";

const COUNT = Number(process.env.COUNT ?? 3200);

/** MB retained by the schemas themselves, and by each candidate after compiling and after checking. */
export interface MemoryResults {
	readonly count: number;
	readonly schemasMB: number;
	readonly candidates: Record<string, { readonly compiledMB: number; readonly checkedMB: number }>;
}

const child = process.argv.indexOf("--child");
if (child >= 0) measure(process.argv[child + 1]);
else run();

function run(): void {
	const results: MemoryResults = { count: COUNT, schemasMB: 0, candidates: {} };
	const names = [...candidates.map((c) => c.name), "typebox interpreter"];
	for (const name of names) {
		const output = execFileSync(process.execPath, ["--expose-gc", import.meta.filename, "--child", name], {
			encoding: "utf8",
			env: { ...process.env, COUNT: String(COUNT) },
		});
		const result = JSON.parse(output);
		Object.assign(results, { schemasMB: result.schemasMB });
		results.candidates[name] = { compiledMB: result.compiledMB, checkedMB: result.checkedMB };
	}
	console.log(`${COUNT} distinct schemas take ${results.schemasMB.toFixed(1)} MB themselves (not counted below).\n`);
	console.log("| candidate | after compiling | after checking |");
	console.log("|---|---:|---:|");
	for (const [name, r] of Object.entries(results.candidates)) {
		console.log(`| ${name} | ${r.compiledMB.toFixed(1)} MB | ${r.checkedMB.toFixed(1)} MB |`);
	}
	const out = process.argv.indexOf("--json");
	if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
}

function measure(name: string): void {
	const candidate = byName.get(name);
	if (candidate === undefined) throw new Error(`Unknown candidate ${name}`);
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("Run with --expose-gc");
	const heap = () => {
		for (let i = 0; i < 4; i++) gc();
		return process.memoryUsage().heapUsed;
	};
	// Warm the library's own code on another corpus, so its lazily compiled functions are not counted.
	for (const { schema, value } of corpus(100, 7)) {
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		for (let i = 0; i < 4; i++) check(value);
	}
	const empty = heap();
	const items = corpus(COUNT, 42);
	const base = heap();
	const prepared = items.map(({ schema }) => candidate.prepare(schema, { draft: "2020-12" }));
	const compiled = heap();
	for (let i = 0; i < items.length; i++) for (let k = 0; k < 3; k++) prepared[i].check(items[i].value);
	const checked = heap();
	(globalThis as { keep?: unknown }).keep = [items, prepared];
	const mb = (bytes: number) => bytes / 1048576;
	console.log(
		JSON.stringify({ schemasMB: mb(base - empty), compiledMB: mb(compiled - base), checkedMB: mb(checked - base) }),
	);
}
