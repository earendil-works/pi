import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contentHash, LoadedModules } from "../../src/hosts/dev-modules.ts";
import { type DevModule, parseDevModules } from "../../src/runtime/dev-protocol.ts";
import { poll } from "./helpers.ts";

// Minimal independent source tree: no mutation of the owner's running tree or actual workspace packages.
test("load hooks hash actual project/workspace sources; only loaded content changes require restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-modules-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const project = join(directory, "apps/p2");
	for (const path of ["src/hosts", "src/runtime", "plugins"]) await mkdir(join(project, path), { recursive: true });
	await mkdir(join(directory, "packages/probe/src"), { recursive: true });
	for (const path of [
		"src/source.ts",
		"src/source-resolver.ts",
		"src/hosts/dev-modules.ts",
		"src/runtime/dev-protocol.ts",
	])
		await copyFile(new URL(`../../${path}`, import.meta.url), join(project, path));
	await writeFile(join(directory, "package.json"), '{"type":"module"}');
	await writeFile(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: {} } }));
	await writeFile(
		join(directory, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { paths: { "@earendil-works/dev-probe": ["packages/probe/src/index.ts"] } } }),
	);
	const runtime = join(project, "src/runtime/probe.ts");
	const workspace = join(directory, "packages/probe/src/index.ts");
	const plugin = join(project, "plugins/reloadable.ts");
	await writeFile(runtime, "export const value: number = 1;\n");
	await writeFile(workspace, "export const value: number = 2;\n");
	await writeFile(plugin, "export const value = 3;\n");
	const entry = join(project, "src/hosts/entry.ts");
	await writeFile(
		entry,
		'import "../runtime/probe.ts"; import "@earendil-works/dev-probe"; import "../../plugins/reloadable.ts?chord2-reload=1"; setInterval(() => {}, 1000);',
	);
	const child = fork(entry, [], {
		execArgv: ["--import", join(project, "src/source.ts")],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		env: { ...process.env, P2_DEV: "1", P2_DEV_MODULE_REPORT: "1" },
	});
	let errors = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		errors += chunk.toString();
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const stopped = once(child, "exit");
			child.kill("SIGTERM");
			await stopped;
		}
	});
	let modules: readonly DevModule[] = [];
	child.on("message", (message) => {
		modules = parseDevModules(message) ?? modules;
	});
	await poll(
		() => {
			assert.equal(child.exitCode, null, errors);
			return modules.some(({ file }) => file === runtime) && modules.some(({ file }) => file === workspace);
		},
		5000,
		"loaded module report",
	);
	for (const file of [entry, runtime, workspace])
		assert.equal(modules.find((module) => module.file === file)?.hash, contentHash(await readFile(file)));
	assert(
		!modules.some(({ file }) => file === plugin),
		"Reload-query facet modules belong to plugin reload, not runtime restart",
	);
	const loadedModules = new LoadedModules();
	loadedModules.set("server", modules);
	// What the dev status reports as restart files (devControl): changed loaded modules, relative to the app.
	const restartFiles = () => loadedModules.changed().map((file) => relative(project, file));
	await writeFile(join(project, "src/hosts/tui-new.ts"), "// unloaded");
	await writeFile(plugin, "export const value = 4;\n");
	assert.deepEqual(restartFiles(), []);
	const original = await readFile(runtime);
	await writeFile(runtime, "export const value = 5;\n");
	assert.deepEqual(restartFiles(), ["src/runtime/probe.ts"]);
	await writeFile(runtime, original);
	assert.deepEqual(restartFiles(), []);
	await writeFile(workspace, "export const value = 6;\n");
	assert.deepEqual(restartFiles(), ["../../packages/probe/src/index.ts"]);
});

test("worker baselines stay separate until each worker exits; deleting or reverting loaded files is detected", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-worker-modules-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "worker-runtime.ts");
	await writeFile(file, "one");
	const modules = new LoadedModules();
	modules.set("worker:old", [{ file, hash: contentHash("one") }]);
	await writeFile(file, "two");
	modules.set("worker:new", [{ file, hash: contentHash("two") }]);
	assert.deepEqual(modules.changed(), [file], "A fresh worker cannot overwrite a running worker's old baseline");
	modules.delete("worker:old");
	assert.deepEqual(modules.changed(), []);
	await rm(file);
	assert.deepEqual(modules.changed(), [file]);
	await writeFile(file, "two");
	assert.deepEqual(modules.changed(), []);
	modules.delete("worker:new");
	await writeFile(file, "three");
	assert.deepEqual(modules.changed(), [], "Stopped workers do not contribute restart requirements");
});

test("reports of another server run's workers are discarded, even when their pid is alive again", async (t) => {
	const reports = await mkdtemp(join(tmpdir(), "p2-dev-reports-"));
	t.after(() => rm(reports, { recursive: true, force: true }));
	// A loaded app file with a hash it does not have: a report naming it means "restart needed".
	const stale = JSON.stringify({
		type: "dev-modules",
		modules: [
			{ file: fileURLToPath(new URL("../../src/hosts/dev-modules.ts", import.meta.url)), hash: "0".repeat(64) },
		],
		pluginFiles: [],
	});
	// This test's pid is alive: an earlier run's worker pid reused by an unrelated process. The layout before server
	// pids, and another server's report.
	const earlier = [`${process.pid}.json`, `${process.pid + 1}-${process.pid}.json`];
	for (const name of earlier) await writeFile(join(reports, name), stale);
	const modules = new LoadedModules(undefined, undefined, reports);
	assert.deepEqual(modules.changed(), []);
	assert.deepEqual(await readdir(reports), []);
	// This run's worker (named with this server's pid) still counts.
	await writeFile(join(reports, `${process.pid}-${process.pid}.json`), stale);
	assert.equal(modules.changed().length, 1);
});
