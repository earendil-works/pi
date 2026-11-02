// Setup cost: compiling a schema the library has not seen, and the time of its first checks. Uses distinct
// schemas from the corpus after warming each library's own code, so it measures a new schema, not a new process.
// Run: node test/bench/setup.ts [--json <file>]

import { writeFileSync } from "node:fs";
import { candidates } from "./candidates.ts";
import { corpus } from "./corpus.ts";

const COUNT = Number(process.env.COUNT ?? 1000);

/** Mean µs per schema: compile, then each of the first three checks and the mean of checks 4-10. */
export type SetupResults = Record<string, { compileUs: number; checkUs: [number, number, number, number] }>;

const results: SetupResults = {};
for (const candidate of candidates) {
	for (const { schema, value } of corpus(200, 7)) {
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		for (let i = 0; i < 10; i++) check(value);
	}
	const items = corpus(COUNT, 99);
	let compile = 0;
	const checks = [0, 0, 0, 0];
	for (const { schema, value } of items) {
		let start = process.hrtime.bigint();
		const { check } = candidate.prepare(schema, { draft: "2020-12" });
		compile += Number(process.hrtime.bigint() - start);
		for (let k = 0; k < 3; k++) {
			start = process.hrtime.bigint();
			check(value);
			checks[k] += Number(process.hrtime.bigint() - start);
		}
		start = process.hrtime.bigint();
		for (let k = 3; k < 10; k++) check(value);
		checks[3] += Number(process.hrtime.bigint() - start) / 7;
	}
	const us = (ns: number) => ns / COUNT / 1000;
	results[candidate.name] = {
		compileUs: us(compile),
		checkUs: [us(checks[0]), us(checks[1]), us(checks[2]), us(checks[3])],
	};
}

console.log("| candidate | compile | check 1 | check 2 | check 3 | checks 4-10 |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const [name, r] of Object.entries(results)) {
	console.log(
		`| ${name} | ${r.compileUs.toFixed(1)} µs | ${r.checkUs.map((x) => `${x.toFixed(2)} µs`).join(" | ")} |`,
	);
}
const out = process.argv.indexOf("--json");
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
