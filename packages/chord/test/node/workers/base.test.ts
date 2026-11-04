// Tests of the worker base (decision "Workers start from the base code the server booted with"): the entry and its base
// code bundled once (an edit after the build runs nowhere, every imported module runs), installed packages external and
// Node builtins kept, a workspace package linked into `node_modules` inlined, the child's `--conditions`, module
// locations and stack traces naming the source files, a broken entry rejected, and the file in a private directory
// restored when a cleaner removed it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerBase, type WorkerBase } from "../../../src/node/workers/base.ts";

const made: string[] = [];
const bases: WorkerBase[] = [];

afterEach(async () => {
	for (const base of bases.splice(0)) base.remove();
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory with `files` (relative path to contents), removed after the test. */
async function project(files: Readonly<Record<string, string>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "chord-worker-base-"));
	made.push(dir);
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), contents);
	}
	return dir;
}

/** `entry`'s base, removed after the test. */
async function built(entry: string, execArgv: readonly string[] = []): Promise<WorkerBase> {
	const base = await buildWorkerBase(entry, execArgv);
	bases.push(base);
	return base;
}

/** What the bundle prints when Node runs it. */
function run(base: WorkerBase): string {
	return execFileSync(process.execPath, [base.file()], { encoding: "utf8" }).trim();
}

describe("the snapshot", () => {
	it("bundles the entry and its imports once: an edit after the build runs nowhere; inputs name both files", async () => {
		const dir = await project({
			"entry.ts": 'import { label } from "./label.ts";\nconst typed: string = label;\nconsole.log(typed);\n',
			"label.ts": 'export const label = "v1";\n',
		});
		const base = await built(join(dir, "entry.ts"));
		await writeFile(join(dir, "label.ts"), 'export const label = "v2";\n');
		expect(run(base)).toBe("v1");
		expect([...base.inputs].sort()).toEqual([join(dir, "entry.ts"), join(dir, "label.ts")]);
	});

	it("runs every imported module, as Node does: sideEffects: false drops no side-effect import", async () => {
		const dir = await project({
			"package.json": '{ "name": "app", "type": "module", "sideEffects": false }',
			"entry.ts": 'import "./effect.ts";\nconsole.log("entry");\n',
			"effect.ts": 'console.log("effect");\n',
		});
		expect(run(await built(join(dir, "entry.ts")))).toBe("effect\nentry");
	});

	it("a broken entry rejects with esbuild's failure", async () => {
		const dir = await project({ "entry.ts": 'import { label } from "./missing.ts";\nconsole.log(label);\n' });
		await expect(buildWorkerBase(join(dir, "entry.ts"), [])).rejects.toThrow(/Could not resolve "\.\/missing\.ts"/);
	});
});

describe("what stays external", () => {
	it("keeps installed packages and builtins external by their files; inlines a workspace package linked into node_modules", async () => {
		const dir = await project({
			"entry.ts": [
				'import { join } from "node:path";',
				'import { where as installed } from "installed";',
				'import { where as linked } from "linked";',
				'const required = require("required");',
				"console.log(JSON.stringify({ installed, linked, required: required.where, join: typeof join }));",
			].join("\n"),
			"node_modules/installed/package.json": '{ "name": "installed", "type": "module", "exports": "./index.js" }',
			"node_modules/installed/index.js": "export const where = import.meta.url;\n",
			"node_modules/required/package.json": '{ "name": "required", "main": "index.js" }',
			"node_modules/required/index.js": "exports.where = __filename;\n",
			"workspace/linked/package.json": '{ "name": "linked", "type": "module", "exports": "./index.js" }',
			"workspace/linked/index.js": 'export const where = "linked v1";\n',
		});
		await symlink(join(dir, "workspace", "linked"), join(dir, "node_modules", "linked"), "dir");
		const base = await built(join(dir, "entry.ts"));
		const bundle = await readFile(base.file(), "utf8");
		expect(bundle).toContain(`from "${pathToFileURL(join(dir, "node_modules", "installed", "index.js")).href}"`);
		expect(bundle).toContain(JSON.stringify(join(dir, "node_modules", "required", "index.js")));
		expect(bundle).toContain('from "node:path"');
		expect(base.inputs).toContain(join(dir, "workspace", "linked", "index.js"));
		// The linked package is base code (in the snapshot); installed packages load from disk at each fork.
		await writeFile(join(dir, "workspace", "linked", "index.js"), 'export const where = "linked v2";\n');
		await writeFile(join(dir, "node_modules", "required", "index.js"), 'exports.where = "required v2";\n');
		expect(JSON.parse(run(base))).toEqual({
			installed: pathToFileURL(join(dir, "node_modules", "installed", "index.js")).href,
			linked: "linked v1",
			required: "required v2",
			join: "function",
		});
	});

	it("resolves with the child's --conditions (both spellings)", async () => {
		const dir = await project({
			"entry.ts": 'import { from } from "conditional";\nconsole.log(from);\n',
			"workspace/conditional/package.json": JSON.stringify({
				name: "conditional",
				type: "module",
				exports: { ".": { source: "./source.js", default: "./index.js" } },
			}),
			"workspace/conditional/source.js": 'export const from = "source";\n',
			"workspace/conditional/index.js": 'export const from = "default";\n',
		});
		await mkdir(join(dir, "node_modules"));
		await symlink(join(dir, "workspace", "conditional"), join(dir, "node_modules", "conditional"), "dir");
		const entry = join(dir, "entry.ts");
		expect(run(await built(entry))).toBe("default");
		expect(run(await built(entry, ["--no-warnings", "--conditions=source"]))).toBe("source");
		expect(run(await built(entry, ["-C", "source"]))).toBe("source");
	});
});

describe("module locations and stack traces", () => {
	it("import.meta and __dirname name each source file, a local __dirname stays the module's own", async () => {
		const dir = await project({
			"entry.ts": [
				'import { here } from "./sub/here.ts";',
				'import cjs from "./sub/legacy.cjs";',
				"console.log(JSON.stringify({ here, cjs, url: import.meta.url }));",
			].join("\n"),
			"sub/here.ts": [
				'import { fileURLToPath } from "node:url";',
				'import { dirname } from "node:path";',
				"const __dirname = dirname(fileURLToPath(import.meta.url));",
				"export const here = { dirname: __dirname, meta: import.meta.dirname, file: import.meta.filename };",
			].join("\n"),
			"sub/legacy.cjs": "module.exports = { dirname: __dirname, filename: __filename };\n",
		});
		const sub = join(dir, "sub");
		expect(JSON.parse(run(await built(join(dir, "entry.ts"))))).toEqual({
			here: { dirname: sub, meta: sub, file: join(sub, "here.ts") },
			cjs: { dirname: sub, filename: join(sub, "legacy.cjs") },
			url: pathToFileURL(join(dir, "entry.ts")).href,
		});
	});

	it("maps stack traces to the source files and lines with --enable-source-maps", async () => {
		const dir = await project({
			"entry.ts": 'import { fail } from "./fail.ts";\nfail();\n',
			"fail.ts":
				"const at: string = import.meta.url;\n\nexport function fail(): void {\n\tthrow new Error(at);\n}\n",
		});
		const base = await built(join(dir, "entry.ts"));
		const { stderr } = spawnSync(process.execPath, ["--enable-source-maps", base.file()], { encoding: "utf8" });
		expect(stderr).toContain(`${join(dir, "fail.ts")}:4:`);
		expect(stderr).toContain(`${join(dir, "entry.ts")}:2:`);
	});
});

describe("the bundle's file", () => {
	it("lives in a private directory; written again into a new one when a cleaner removed it; removed by remove", async () => {
		const dir = await project({ "entry.ts": 'console.log("ran");\n' });
		const base = await buildWorkerBase(join(dir, "entry.ts"), []);
		const first = base.file();
		expect([statSync(dirname(first)).mode & 0o777, statSync(first).mode & 0o777]).toEqual([0o700, 0o600]);
		await rm(dirname(first), { recursive: true, force: true });
		const second = base.file();
		expect(second).not.toBe(first);
		expect(run(base)).toBe("ran");
		base.remove();
		expect(existsSync(dirname(second))).toBe(false);
	});
});
