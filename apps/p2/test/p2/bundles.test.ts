// Tests of p2's own esbuild builds (`src/hosts/bundles.ts`): they go through Chord's counted build, so Chord's idle stop
// of esbuild's one service never stops one of them under way.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { esbuildBuild } from "@earendil-works/chord/plugins";
import { buildBrowserScript } from "../../src/hosts/bundles.ts";

// Review of the perf pass, round 2 (Astra): with p2's build calling esbuild directly, Chord's idle timer, started by a
// build of its own, stopped the service under p2's build ("The service was stopped").
it("a browser script built while Chord's idle time runs out completes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "p2-bundles-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "peer.ts");
	await writeFile(file, 'console.log("peer build");');
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await esbuildBuild({ stdin: { contents: "1" }, write: false });
	t.mock.timers.tick(1500);
	const peer = buildBrowserScript(file);
	t.mock.timers.tick(501);
	assert.match(await peer, /peer build/);
});
