// Tests of what a base build read (`base-inputs.ts`, p3 step 0a): the hash a record keeps, the one read that records a
// file, and the esbuild plugin loading every file through it with esbuild's own loader for its extension.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { contentHash, readRecorded, recordedSources } from "../../../src/node/plugins/base-inputs.ts";
import { tempRoot, writeFiles } from "./support.ts";

describe("recording what a build read", () => {
	it("hashes bytes with SHA-256, and records a file's bytes as it reads them", async () => {
		expect(contentHash(new TextEncoder().encode("abc"))).toBe(createHash("sha256").update("abc").digest("hex"));
		const dir = await tempRoot();
		await writeFile(join(dir, "a.ts"), "export const a = 1;");
		const inputs = new Map<string, string>();
		const bytes = await readRecorded(join(dir, "a.ts"), inputs);
		expect(bytes.toString()).toBe("export const a = 1;");
		expect(inputs).toEqual(new Map([[join(dir, "a.ts"), contentHash(bytes)]]));
	});

	it("loads every file of a build with esbuild's own loader and records each one's bytes", async () => {
		const dir = await tempRoot();
		await writeFiles(dir, {
			"main.ts":
				'import data from "./d.json";\nimport styles from "./s.module.css";\nimport "./g.css";\nconsole.log(data.k, styles.x);\n',
			"d.json": '{ "k": 1 }',
			"s.module.css": ".x { color: red; }",
			"g.css": "body { margin: 0; }",
		});
		const built = (plugins: Plugin[]) =>
			build({
				entryPoints: [join(dir, "main.ts")],
				bundle: true,
				write: false,
				outdir: "/out",
				logLevel: "silent",
				plugins,
			});
		const plain = await built([]);
		const inputs = new Map<string, string>();
		const recorded = await built([recordedSources(inputs)]);
		expect(recorded.outputFiles.map(({ text }) => text)).toEqual(plain.outputFiles.map(({ text }) => text));
		const names = ["main.ts", "d.json", "s.module.css", "g.css"];
		expect([...inputs.keys()].sort()).toEqual(names.map((name) => join(dir, name)).sort());
		for (const name of names) expect(inputs.get(join(dir, name))).toBe(contentHash(await readFile(join(dir, name))));
	});
});
