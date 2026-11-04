// Hot validation speed: ns per check for each case and candidate, after warm-up. Each round times every
// candidate once, in a rotated order; the result is the median of the rounds.
// Run: node test/bench/speed.ts [--json <file>]   (add --disallow-code-generation-from-strings for no eval)

import { writeFileSync } from "node:fs";
import { candidates } from "./candidates.ts";
import { cases } from "./cases.ts";

const ROUNDS = Number(process.env.ROUNDS ?? 15);
const ROUND_MS = Number(process.env.ROUND_MS ?? 30);
let sink = 0;

function time(check: (v: unknown) => boolean, value: unknown, n: number): number {
	const start = process.hrtime.bigint();
	for (let i = 0; i < n; i++) if (check(value)) sink++;
	return Number(process.hrtime.bigint() - start) / n;
}

function median(values: number[]): number {
	return [...values].sort((a, b) => a - b)[values.length >> 1];
}

/**
 * Median ns per check, by case name, input ("valid"/"invalid") and candidate name; null where the candidate cannot
 * compile the schema (Ajv without eval).
 */
export type SpeedResults = Record<string, Record<"valid" | "invalid", Record<string, number | null>>>;

const results: SpeedResults = {};
for (const c of cases) {
	results[c.name] = { valid: {}, invalid: {} };
	for (const input of ["valid", "invalid"] as const) {
		const value = c[input];
		const runs: {
			candidate: (typeof candidates)[number];
			check: (v: unknown) => boolean;
			n: number;
			samples: number[];
		}[] = [];
		for (const candidate of candidates) {
			let check: (v: unknown) => boolean;
			try {
				check = candidate.prepare(c.schema, { draft: "2020-12" }).check;
			} catch (error) {
				if (!(error instanceof EvalError)) throw error;
				results[c.name][input][candidate.name] = null;
				continue;
			}
			if (check(value) !== (input === "valid")) throw new Error(`${candidate.name} gets ${c.name} (${input}) wrong`);
			let n = 1000;
			while (time(check, value, n) * n < ROUND_MS * 1e6 && n < 1e8) n *= 2;
			runs.push({ candidate, check, n, samples: [] });
		}
		for (let round = 0; round < ROUNDS; round++) {
			for (let i = 0; i < runs.length; i++) {
				const run = runs[(i + round) % runs.length];
				run.samples.push(time(run.check, value, run.n));
			}
		}
		for (const run of runs) results[c.name][input][run.candidate.name] = median(run.samples);
	}
}

const names = candidates.map((c) => c.name);
console.log(`| case | input | ${names.join(" | ")} |`);
console.log(`|---|---|${names.map(() => "---:").join("|")}|`);
for (const [name, inputs] of Object.entries(results)) {
	for (const [input, ns] of Object.entries(inputs)) {
		console.log(`| ${name} | ${input} | ${names.map((n) => format(ns[n])).join(" | ")} |`);
	}
}
const out = process.argv.indexOf("--json");
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
if (sink < 0) console.log(sink);

function format(ns: number | null): string {
	if (ns === null) return "fails";
	return ns >= 1000 ? `${(ns / 1000).toFixed(ns >= 10000 ? 0 : 1)} µs` : `${ns.toFixed(0)} ns`;
}
