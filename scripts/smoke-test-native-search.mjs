// Exercise actual native content/glob searches under Node or Bun without rg/fd on PATH.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const addon = process.argv[2];
if (!addon) throw new Error("Usage: smoke-test-native-search.mjs <pi-search.node>");
const { SearchJob } = createRequire(import.meta.url)(resolve(addon));
const root = mkdtempSync(join(tmpdir(), "pi-native-search-smoke-"));
try {
	mkdirSync(join(root, "nested"));
	writeFileSync(join(root, "nested", "source.ts"), "before\nneedle\nafter\n");
	writeFileSync(join(root, "excluded.ts"), "needle\n");
	process.env.PATH = "";
	const target = { path: root, ranges: [] };
	const result = await new SearchJob().grep({
		targets: [target], exclusions: ["**/excluded.ts"], pattern: "need(?=le)", ignoreCase: false,
		literal: false, gitignore: true, contextBefore: 1, contextAfter: 1,
		perFileLimit: 20, matchLimit: 2000, fileLimit: 20, skip: 0,
	});
	assert.equal(result.files.length, 1);
	assert.equal(result.files[0].path.replaceAll("\\", "/"), `${root.replaceAll("\\", "/")}/nested/source.ts`);
	assert.deepEqual(result.files[0].lines.map(({ number, text, isMatch }) => ({ number, text, isMatch })), [
		{ number: 1, text: "before", isMatch: false },
		{ number: 2, text: "needle", isMatch: true },
		{ number: 3, text: "after", isMatch: false },
	]);
	const found = await new SearchJob().glob({ targets: [target], exclusions: ["**/excluded.ts"], pattern: "**/*.ts", hidden: true, gitignore: true, limit: 200 });
	assert.deepEqual(found.paths, [result.files[0].path]);
	const cancelled = new SearchJob();
	cancelled.cancel();
	await assert.rejects(cancelled.glob({ targets: [target], exclusions: [], pattern: "**/*", hidden: true, gitignore: true, limit: 200 }), /aborted/i);
	console.log(`Native grep/glob smoke passed (${process.versions.bun ? "Bun" : "Node"}, ${process.platform}-${process.arch})`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
