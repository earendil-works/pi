// Conformance of every candidate on the vendored JSON-Schema-Test-Suite (drafts 2020-12 and 7), by section:
// core, optional and optional/format. Every candidate gets the remote documents and meta-schemas; format tests run
// with pi-schema's format checks (the other libraries check formats on their own or not at all). Zod goes through
// z.fromJSONSchema, which refuses some keywords and every remote $ref: a schema it refuses fails all its tests.
// Run: node test/bench/conformance.ts [--json <file>]

import { writeFileSync } from "node:fs";
import { formats } from "../../src/formats/index.ts";
import { suiteFiles, suiteSchemas } from "../suite.ts";
import { candidates } from "./candidates.ts";

/** Passed and total tests by section ("draft2020-12 core", ...) and candidate name. */
export type ConformanceResults = Record<string, { total: number; passed: Record<string, number> }>;

const results: ConformanceResults = {};
for (const file of suiteFiles()) {
	const kind = file.name.includes("/optional/format/")
		? "format"
		: file.name.includes("/optional/")
			? "optional"
			: "core";
	const section = `${file.name.split("/")[0]} ${kind}`;
	results[section] ??= { total: 0, passed: Object.fromEntries(candidates.map((c) => [c.name, 0])) };
	for (const group of file.groups) {
		results[section].total += group.tests.length;
		for (const candidate of candidates) {
			let check: ((v: unknown) => boolean) | undefined;
			try {
				check = candidate.prepare(structuredClone(group.schema), {
					draft: file.draft,
					schemas: suiteSchemas(),
					formats: kind === "format" ? formats : undefined,
					suite: true,
				}).check;
			} catch {
				continue; // A schema the library cannot compile fails all its tests.
			}
			for (const test of group.tests) {
				try {
					if (check(test.data) === test.valid) results[section].passed[candidate.name]++;
				} catch {
					// A throw while checking fails the test.
				}
			}
		}
	}
}

const names = candidates.map((c) => c.name);
console.log(`| section | tests | ${names.join(" | ")} |`);
console.log(`|---|---:|${names.map(() => "---:").join("|")}|`);
for (const [section, r] of Object.entries(results)) {
	console.log(`| ${section} | ${r.total} | ${names.map((n) => r.passed[n]).join(" | ")} |`);
}
const out = process.argv.indexOf("--json");
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
