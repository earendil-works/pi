// Exercises the file operations used by package build scripts without touching build output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./package-files.mjs", import.meta.url));

function workspace(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-files-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function run(directory, ...args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
}

test("clean removes directories and files and ignores missing paths", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "dist", "nested"), { recursive: true });
	writeFileSync(join(directory, "dist", "nested", "file.js"), "output");
	writeFileSync(join(directory, "output.txt"), "output");
	assert.equal(run(directory, "clean", "dist", "output.txt", "missing").status, 0);
	assert.equal(existsSync(join(directory, "dist")), false);
	assert.equal(existsSync(join(directory, "output.txt")), false);
});

test("copy expands patterns, creates directories, and overwrites existing assets", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "source assets"));
	writeFileSync(join(directory, "source assets", "dark.json"), "dark");
	writeFileSync(join(directory, "source assets", "light.json"), "light");
	writeFileSync(join(directory, "source assets", "ignored.txt"), "ignored");
	const args = ["copy", "source assets/*.json", "output/assets"];
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "dark");
	assert.equal(readFileSync(join(directory, "output/assets/light.json"), "utf8"), "light");
	assert.equal(existsSync(join(directory, "output/assets/ignored.txt")), false);
	writeFileSync(join(directory, "source assets", "dark.json"), "updated");
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "updated");
});

test("copy accepts multiple files and preserves directory names and nested contents", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "docs", "nested"), { recursive: true });
	writeFileSync(join(directory, "docs", "nested", "guide.md"), "guide");
	writeFileSync(join(directory, "README.md"), "readme");
	assert.equal(run(directory, "copy", "docs", "README.md", "dist").status, 0);
	assert.equal(readFileSync(join(directory, "dist", "docs", "nested", "guide.md"), "utf8"), "guide");
	assert.equal(readFileSync(join(directory, "dist", "README.md"), "utf8"), "readme");
});

test("copy fails when an asset pattern matches nothing", (t) => {
	const result = run(workspace(t), "copy", "missing/*.json", "dist");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No files match missing/);
});

test("executable adds executable bits without removing existing permissions", (t) => {
	const directory = workspace(t);
	for (const name of ["cli.js", "rpc.js"]) writeFileSync(join(directory, name), "entry", { mode: 0o640 });
	const mode = statSync(join(directory, "cli.js")).mode;
	assert.equal(run(directory, "executable", "cli.js", "rpc.js").status, 0);
	if (process.platform !== "win32") {
		assert.equal(statSync(join(directory, "cli.js")).mode & 0o777, (mode | 0o111) & 0o777);
		assert.equal(statSync(join(directory, "rpc.js")).mode & 0o111, 0o111);
	}
});

test("invalid commands and missing arguments fail", (t) => {
	const directory = workspace(t);
	for (const args of [[], ["unknown", "dist"], ["clean"], ["copy", "dist"], ["executable"]]) {
		const result = run(directory, ...args);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage: package-files/);
	}
});
