// Where p3's files are and how its processes start (`src/install.ts`): the session worker's V8 flags, chosen by the
// Node's version, which a Node that does not know one of them refuses at the worker's start ("bad option"). Run on
// each Node p3 supports (the release tests run on Node 24 and 26).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { WORKER, WORKER_V8_FLAGS, workerV8Flags } from "../src/install.ts";

/** Runs this Node with `args`: its exit code, stdout and stderr. */
function node(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [...args], (error, stdout, stderr) => {
			resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
}

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

	it("are the four for every Node, and V8's managed zone memory from Node 26 on, which Node 24's V8 does not know", () => {
		const every = [
			"--liftoff-only",
			"--optimize-for-size",
			"--max-semi-space-size=4",
			"--gc-memory-reducer-start-delay-ms=8000",
		];
		for (const version of ["24.4.0", "24.4.1", "24.99.0", "25.9.0"]) assert.deepEqual(workerV8Flags(version), every);
		for (const version of ["26.0.0", "26.11.1", "27.1.0", "100.0.0"]) {
			assert.deepEqual(workerV8Flags(version), [...every, "--managed-zone-memory"]);
		}
	});

	it("are what a worker starts with, after the flags of its layout", () => {
		assert.deepEqual(WORKER.execArgv?.slice(-WORKER_V8_FLAGS.length), [...WORKER_V8_FLAGS]);
	});
});
