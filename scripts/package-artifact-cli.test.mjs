import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDirectory, "..");

function runScript(name, args) {
	return spawnSync(process.execPath, [join(scriptsDirectory, name), ...args], { cwd: repoRoot, encoding: "utf8" });
}

function assertFailsBeforeWork(result, message) {
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, message);
	assert.doesNotMatch(result.stdout, /generate:models|npm run clean/);
}

test("rejects a missing local-release --out value before release work starts", () => {
	for (const args of [["--out"], ["--out", "--skip-check"]]) {
		assertFailsBeforeWork(runScript("local-release.mjs", args), /Option '--out.*argument (?:missing|is ambiguous)/);
	}
});

test("rejects malformed package artifact options before doing work", () => {
	assertFailsBeforeWork(runScript("pack-packages.mjs", ["--out", "--force"]), /Option '--out' argument is ambiguous/);
	assertFailsBeforeWork(runScript("use-local-packages.mjs", ["--manifest", "--consumer", "target"]), /Option '--manifest' argument is ambiguous/);
	assertFailsBeforeWork(runScript("use-local-packages.mjs", ["--unknown", "value"]), /Unknown option '--unknown'/);
	assertFailsBeforeWork(
		runScript("use-local-packages.mjs", ["--manifest", "missing.json", "--consumer", "target", "--package", "example", "--package-manager", "yarn"]),
		/Unsupported package manager: yarn/,
	);
});
