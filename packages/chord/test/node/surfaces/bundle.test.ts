// Tests of base bundles' resolution (p3 step 0a): packages resolve with the given conditions (a source checkout's
// source, not its `dist/`), by default the server process's (`--conditions`/`-C` of its flags and of a quoted
// `NODE_OPTIONS`), a browser build keeping its `module` condition and `browser` field, and every file read recorded
// with its bytes' hash.

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../../../src/node/plugins/base-inputs.ts";
import { buildBase, processConditions } from "../../../src/node/surfaces/bundle.ts";
import { tempDir } from "../app/support.ts";

/** A directory with `files` and the workspace packages under `workspace/` linked into its `node_modules`. */
async function project(files: Readonly<Record<string, string>>, linked: readonly string[] = []): Promise<string> {
	const dir = await tempDir();
	for (const [name, text] of Object.entries(files)) {
		await mkdir(join(dir, name, ".."), { recursive: true });
		await writeFile(join(dir, name), text);
	}
	await mkdir(join(dir, "node_modules"), { recursive: true });
	for (const name of linked) await symlink(join(dir, "workspace", name), join(dir, "node_modules", name), "dir");
	return dir;
}

/** A workspace package `chordish` exporting its source under the `source` condition and its build otherwise. */
const CHORDISH = {
	"workspace/chordish/package.json": JSON.stringify({
		name: "chordish",
		type: "module",
		exports: { ".": { source: "./src/index.ts", default: "./dist/index.js" } },
	}),
	"workspace/chordish/src/index.ts": 'export const from: string = "source";\n',
	"workspace/chordish/dist/index.js": 'export const from = "dist";\n',
	"main.ts": 'import { from } from "chordish";\nconsole.log(from);\n',
};

/** The bundle's script text. */
function scriptOf(bundle: Awaited<ReturnType<typeof buildBase>>): string {
	return new TextDecoder().decode(bundle.files.get(bundle.script)!.bytes);
}

describe("conditions", () => {
	const nodeOptions = process.env.NODE_OPTIONS;

	afterEach(() => {
		if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = nodeOptions;
	});

	it("resolves with the given conditions: the source as input, not dist/, each with its bytes' hash", async () => {
		const dir = await project(CHORDISH, ["chordish"]);
		for (const platform of ["browser", "sandbox"] as const) {
			const bundle = await buildBase(join(dir, "main.ts"), platform, "/p/", ["source"]);
			const source = join(dir, "workspace", "chordish", "src", "index.ts");
			expect([...bundle.inputs.keys()].sort()).toEqual([join(dir, "main.ts"), source].sort());
			expect(bundle.inputs.get(source)).toBe(contentHash(await readFile(source)));
			expect(scriptOf(bundle)).toContain('"source"');
		}
		const plain = await buildBase(join(dir, "main.ts"), "browser", "/p/", []);
		expect([...plain.inputs.keys()]).toContain(join(dir, "workspace", "chordish", "dist", "index.js"));
	});

	it("takes the server process's conditions by default: its flags and a quoted NODE_OPTIONS", async () => {
		expect(
			processConditions(
				["--no-warnings", "--conditions=source", "-C", "edge"],
				'--max-old-space-size=100 --conditions="dev ish" -C "a\\"b" -C=c',
			),
		).toEqual(["dev ish", 'a"b', "c", "source", "edge"]);
		expect(processConditions([], undefined)).toEqual([]);
		const dir = await project(CHORDISH, ["chordish"]);
		process.env.NODE_OPTIONS = '--conditions "source"';
		const bundle = await buildBase(join(dir, "main.ts"), "browser", "/p/", undefined);
		expect(scriptOf(bundle)).toContain('"source"');
	});

	it("keeps a browser build's module condition and browser field with custom conditions", async () => {
		const dir = await project(
			{
				"workspace/dual/package.json": JSON.stringify({
					name: "dual",
					exports: { ".": { module: "./esm.js", default: "./cjs.js" } },
				}),
				"workspace/dual/esm.js": 'export const dual = "module";\n',
				"workspace/dual/cjs.js": 'exports.dual = "default";\n',
				"workspace/fielded/package.json": JSON.stringify({
					name: "fielded",
					main: "./node.js",
					browser: { "./node.js": "./browser.js" },
				}),
				"workspace/fielded/node.js": 'exports.fielded = "node";\n',
				"workspace/fielded/browser.js": 'exports.fielded = "browser";\n',
				"main.ts":
					'import { dual } from "dual";\nimport { fielded } from "fielded";\nconsole.log(dual, fielded);\n',
			},
			["dual", "fielded"],
		);
		const script = scriptOf(await buildBase(join(dir, "main.ts"), "browser", "/p/", ["source"]));
		expect(script).toContain('"module"');
		expect(script).toContain('"browser"');
		expect(script).not.toContain('"node"');
	});
});
