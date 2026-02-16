#!/usr/bin/env node

const argv = process.argv.slice(2);

// Allow human help mode (no jsonl flag required).
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
	process.stdout.write("fixture help\n");
	process.exit(0);
}

const hasJsonl = argv.includes("--jsonl") || argv.includes("--json");

const noJsonlSupported = argv.includes("--no-jsonl-supported");

if (noJsonlSupported) {
	if (hasJsonl) {
		process.stderr.write("error: unknown option '--jsonl'\n");
		process.exit(1);
	}
	process.stdout.write("RAW OK\n");
	process.exit(0);
}

if (!hasJsonl) {
	process.stderr.write("[fixture] missing --jsonl\n");
	process.exit(2);
}

const shouldFail = argv.includes("--fail");
const shouldPlain = argv.includes("--plain");

process.stderr.write("[fixture] starting\n");

if (shouldPlain) {
	process.stdout.write("Query: plain mode\n\n1. hello\n");
	process.exit(0);
}

const shouldStderrOnlyFail = argv.includes("--stderr-only-fail");
if (shouldStderrOnlyFail) {
	process.stderr.write("[fixture] stderr-only failure\n");
	process.exit(1);
}

const ts = Date.now();
process.stdout.write(`${JSON.stringify({ type: "meta", ts, tool: "fixture", version: "0.0.0", argv })}\n`);

if (!shouldFail) {
	process.stdout.write(
		`${JSON.stringify({ type: "output", ts: ts + 1, tool: "fixture", format: "text", content: "hello" })}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({ type: "result", ts: ts + 2, tool: "fixture", ok: true, exitCode: 0, summary: { kind: "ok" } })}\n`,
	);
	process.exit(0);
}

process.stdout.write(
	`${JSON.stringify({ type: "error", ts: ts + 1, tool: "fixture", kind: "failed", message: "boom" })}\n`,
);
process.stdout.write(
	`${JSON.stringify({ type: "result", ts: ts + 2, tool: "fixture", ok: false, exitCode: 1, summary: { kind: "fail" } })}\n`,
);
process.exit(1);
