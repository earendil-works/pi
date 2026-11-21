// The helpers of a plugin's tests (`@earendil-works/p3/v1/testing`). `testPlugin`: a tested facet gets the base's facet
// as its real host has it, and a directory of its own: a new temporary one per test (two tests of one session share
// nothing), removed at its close. `testServer`: the plugins under test load beside the built-in ones (one that fails
// fails the start); `stop` keeps the data directory, `restart` starts on it again, `close` removes it.

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, local, Sessions, str } from "@earendil-works/p3/v1";
import { ServerCommands } from "@earendil-works/p3/v1/server";
import { testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "./until.ts";

/** What the plugin the test writes serves: its host's directory. */
const Dir = local("dir.dir", { version: 1, params: {}, members: { dir: str() } });

/** The plugin's facets: each serves `Dir` with its runtime's directory (the server's data directory, a worker's). */
const PLUGIN = {
	"package.json": JSON.stringify({ name: "dir", private: true, type: "module" }),
	"server.ts": [
		'import { constant, defineFacet, local, str } from "@earendil-works/p3/v1";',
		'import { ServerRuntime } from "@earendil-works/p3/v1/server";',
		'const Dir = local("dir.dir", { version: 1, params: {}, members: { dir: str() } });',
		"export default defineFacet((host) =>",
		"	host.serve(Dir, (_params, self) => ({ dir: constant(self.registry(ServerRuntime).value.dataDir) })),",
		");",
	].join("\n"),
	"worker.ts": [
		'import { constant, defineFacet, local, str } from "@earendil-works/p3/v1";',
		'import { WorkerRuntime } from "@earendil-works/p3/v1/worker";',
		'const Dir = local("dir.dir", { version: 1, params: {}, members: { dir: str() } });',
		"export default defineFacet((host) =>",
		"	host.serve(Dir, (_params, self) => ({ dir: constant(self.registry(WorkerRuntime).value.dir) })),",
		");",
	].join("\n"),
};

const root = await mkdtemp(join(tmpdir(), "p3-testing-"));
after(() => rm(root, { recursive: true, force: true }));
const plugin = join(root, "dir");
await mkdir(plugin);
for (const [name, text] of Object.entries(PLUGIN)) await writeFile(join(plugin, name), text);

/** Whether `path` exists. */
function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("testPlugin's directories", () => {
	for (const facet of [{ kind: "server" }, { kind: "worker", session: "s" }] as const) {
		it(`gives two tests of a ${facet.kind} facet two directories, each removed at its close`, async () => {
			const [one, other] = [await testPlugin(plugin, facet, context), await testPlugin(plugin, facet, context)];
			const dirs = [one, other].map(async (t) => (await t.host.get(Dir, {}, context)).dir.value);
			const [first, second] = await Promise.all(dirs);
			assert.notEqual(first, second);
			// Each test's own: a file one writes is not the other's.
			await writeFile(join(first, "marker"), "one");
			assert.equal(await exists(join(second, "marker")), false);
			await one.close(context);
			await other.close(context);
			assert.deepEqual([await exists(first), await exists(second)], [false, false]);
		});
	}

	it("serves the base's registries on the server, composed as the server does", async () => {
		const t = await testPlugin(plugin, { kind: "server" }, context);
		try {
			assert.equal((await t.host.registry(ServerCommands, context)).value.size, 0);
		} finally {
			await t.close(context);
		}
	});
});

describe("testServer", () => {
	it("loads the plugins under test beside the built-in ones; stop keeps the data directory, close removes it", async () => {
		const t = await testServer({ plugins: [plugin] }, context);
		const dataDir = await t.host.root(
			async (ctx) => (await ctx.get(Dir, {})).dir.value,
			within("the plugin", context),
		);
		assert.equal(dataDir, t.dataDir);
		// A built-in plugin's object, through a client signed in as the owner.
		assert.equal((await (await t.client(context)).get(Sessions, {}, context)).variant, "owner");
		await t.stop(context);
		assert.ok(await exists(join(dataDir, "server", "store.sqlite")));
		const again = await t.restart(context);
		assert.equal(again.dataDir, dataDir);
		await again.close(context);
		assert.equal(await exists(dataDir), false);
	});

	it("fails the start when a plugin under test fails to load", async () => {
		const broken = join(root, "broken");
		await mkdir(broken);
		await writeFile(join(broken, "package.json"), JSON.stringify({ name: "broken", private: true, type: "module" }));
		await writeFile(join(broken, "server.ts"), 'throw new Error("broken: on purpose");\n');
		await assert.rejects(testServer({ plugins: [broken] }, context), /broken/);
	});
});
