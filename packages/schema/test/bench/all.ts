// Runs every benchmark, each in its own process, and writes the results as JSON next to the printed tables.
// Speed runs twice: normally and with code generation from strings disabled, as under a strict CSP.
// The children run with ATA_NO_NATIVE=1 (see candidates.ts).
// Run: npm run bench [-- --out <file>]   (default: pi-schema-bench-results.json in the temp directory)

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

const dir = import.meta.dirname;
const outIndex = process.argv.indexOf("--out");
const out = outIndex >= 0 ? process.argv[outIndex + 1] : join(tmpdir(), "pi-schema-bench-results.json");

const runs: [string, string, string[]][] = [
	["conformance", "conformance.ts", []],
	["speed", "speed.ts", []],
	["speedNoEval", "speed.ts", ["--disallow-code-generation-from-strings"]],
	["setup", "setup.ts", []],
	["memory", "memory.ts", []],
	["size", "size.ts", []],
];

const results: Record<string, unknown> = {
	node: process.version,
	cpu: cpus()[0]?.model ?? "unknown",
	date: new Date().toISOString(),
};
for (const [key, file, flags] of runs) {
	const json = join(tmpdir(), `pi-schema-bench-${key}.json`);
	console.log(`\n## ${key}${flags.length > 0 ? ` (${flags.join(" ")})` : ""}\n`);
	execFileSync(process.execPath, [...flags, join(dir, file), "--json", json], {
		stdio: "inherit",
		env: { ...process.env, ATA_NO_NATIVE: "1" },
	});
	results[key] = JSON.parse(readFileSync(json, "utf8"));
	rmSync(json);
}
writeFileSync(out, JSON.stringify(results, null, "\t"));
console.log(`\nResults: ${out}`);
