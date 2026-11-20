// The plugin tier's helper (`@earendil-works/p3/v1/testing`): a tested facet gets the base's facet as its real host
// has it, and a directory of its own: a new temporary one per test (two tests of one session share nothing), removed
// at its close.

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, local, str } from "@earendil-works/p3/v1";
import { ServerCommands } from "@earendil-works/p3/v1/server";
import { testPlugin } from "@earendil-works/p3/v1/testing";

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
