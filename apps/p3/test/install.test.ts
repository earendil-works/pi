// Where p3's files are (`src/install.ts`): p3's root from each of the module's three places; and the session worker's
// V8 flags, which a Node that does not know one of them refuses at the worker's start, checked on this Node.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { filesOf, WORKER, WORKER_V8_FLAGS } from "../src/install.ts";

/** Runs this Node with `args`: its exit code, stdout and stderr. */
function node(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [...args], (error, stdout, stderr) => {
			resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
}

describe("p3's files", () => {
	const root = join("/", "x", "p3");
	const dist = join(root, "dist");
	it("are found from a checkout's `src/`, the command's bundle and the API compiled into `dist/src/`", () => {
		const source = filesOf(join(root, "src", "install.ts"));
		assert.deepEqual(
			[source.root, source.plugins, source.worker.entry],
			[root, join(root, "plugins"), join(root, "src", "worker.ts")],
		);
		assert.equal(source.command.at(-1), join(root, "src", "bin.ts"));
		// `/v1/testing`'s `testServer` imports the module compiled into `dist/src/`: its workers are the bundle's too.
		for (const file of [join(dist, "main.js"), join(dist, "src", "install.js")]) {
			const built = filesOf(file);
			assert.deepEqual(
				[built.root, built.plugins, built.worker.entry, built.command, built.supervisor],
				[
					root,
					join(root, "plugins"),
					join(dist, "worker.js"),
					[join(dist, "p3.js")],
					[join(dist, "supervisor.js")],
				],
				file,
			);
		}
	});
});

describe("a session worker's V8 flags", () => {
	it(`are each known to this Node's V8 (Node ${process.versions.node}), and a worker's Node starts with them`, async () => {
		const options = (await node(["--v8-options"])).stdout;
		for (const flag of WORKER_V8_FLAGS) {
			const name = flag.replace(/^--/, "").split("=")[0]!;
			assert.match(options, new RegExp(`^\\s+--${name} `, "m"), `${flag} is not in node --v8-options`);
		}
		assert.deepEqual(await node([...WORKER_V8_FLAGS, "-e", "0"]), { code: 0, stdout: "", stderr: "" });
		// The check would see a flag this Node does not know.
		const unknown = await node(["--no-such-v8-flag-p3", "-e", "0"]);
		assert.notEqual(unknown.code, 0);
	});

	it("are what a worker starts with, after the flags of its layout", () => {
		assert.deepEqual(WORKER.execArgv.slice(-WORKER_V8_FLAGS.length), [...WORKER_V8_FLAGS]);
	});
});
