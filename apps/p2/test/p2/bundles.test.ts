// The web bundle is named by its content: rebuilding the same source gives the same file names (browsers and any later
// shared cache keep them), no output depends on where the checkout lives, and a source change gives new names.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildWebBundle, MAX_WEB_BUNDLE } from "../../src/hosts/bundles.ts";

test("the web bundle's names follow its content only", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-bundles-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "probe"));
	const facet = join(directory, "probe/web.tsx");
	const write = (word: string) =>
		writeFile(facet, `export default { setup() { console.log(${JSON.stringify(word)}); } };`);
	await write("first");
	const first = await buildWebBundle(["probe"], directory);
	const facetPath = await realpath(facet);
	const input = first.inputs.find(({ file }) => file === facetPath);
	assert(input, "the facet's exact built bytes are part of the dev-change baseline");
	assert.equal(
		input.hash,
		createHash("sha256")
			.update(await readFile(facet))
			.digest("hex"),
	);
	const again = await buildWebBundle(["probe"], directory);
	assert.deepEqual([...again.files.keys()].sort(), [...first.files.keys()].sort());
	assert.equal(again.version, first.version);
	// Names are hashes of the files, source maps included: the checkout's absolute path must appear in none.
	const checkout = fileURLToPath(new URL("../../", import.meta.url));
	for (const [name, file] of first.files)
		assert(!Buffer.from(file.body).toString("latin1").includes(checkout), `${name} names the checkout's path`);
	await write("second");
	const changed = await buildWebBundle(["probe"], directory);
	assert.notEqual(changed.script, first.script);
	assert.notEqual(changed.version, first.version);
	// The stylesheet comes from the unchanged runtime: its name stays, so a browser keeps it cached.
	assert.equal(changed.style, first.style);
});

test("a web bundle over the size cap is refused", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-bundles-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "huge"));
	// Minification keeps a string literal as it is: this one alone is over the cap.
	const filler = "x".repeat(MAX_WEB_BUNDLE);
	await writeFile(join(directory, "huge/web.tsx"), `export default { setup() { console.log("${filler}"); } };`);
	await assert.rejects(buildWebBundle(["huge"], directory), /Web bundle exceeds 8 MiB/);
});
