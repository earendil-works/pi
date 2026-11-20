// The runner plugin reloaded on p3's real server (ERNDL-954): its built-in plugins copied into a root of the test's
// own, so the test edits the runner's server facet and applies it, as an owner editing a plugin does. The old runner
// stops every worker, and the sessions plugin's waker starts the workers of the `working` sessions again on the new
// runner (an unheld session's run would otherwise stay cut off until a restart); the apply's worker step is the new
// runner's, so a worker plugin changed in the same apply reaches the worker the new runner started. A held session
// comes back by itself: the route's resolve waits for the next runner while there is none.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, remote, Session, str } from "@earendil-works/p3/v1";
import { WorkerRunners } from "@earendil-works/p3/v1/server";
import { Sessions } from "../plugins/sessions/contract.ts";
import { Probe } from "./plugins/probe/contract.ts";
import { alive, eventually, type TestServer, testServer } from "./support.ts";
import { until } from "./until.ts";

/** The contract of the worker plugin the test writes (`marked`): its mark, on a session's worker. */
const Marked = remote("marked.marked", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { mark: str() } } },
});

/** The source of a single-file worker plugin serving `Marked` with `mark`. */
function marked(mark: string): string {
	return `import { constant, defineFacet, remote, Session, str } from "@earendil-works/p3/v1";
const Marked = remote("marked.marked", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { mark: str() } } },
});
export default defineFacet((host) => {
	host.serve(Marked, () => ({ variant: "owner", members: { mark: constant(${JSON.stringify(mark)}) } }));
});
`;
}

/** The checkout's built-in plugins, which a test copies. */
const BUILT_IN = fileURLToPath(new URL("../plugins/", import.meta.url));

/** A test's server whose built-in plugins are a copy the test edits (`builtIn`). */
type EditableServer = { readonly t: TestServer; readonly builtIn: string };

let running: TestServer | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** Starts a test's server on a new data directory with a copy of the built-in plugins (their tests left out). */
async function editableServer(): Promise<EditableServer> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-e2e-"));
	const builtIn = join(dataDir, "builtin");
	await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
	running = await testServer({ dataDir, builtIn });
	return { t: running, builtIn };
}

/** A session that is `working`, its worker kept alive by its work and held by nobody: its id and the worker's pid. */
async function workingSession(t: TestServer): Promise<{ readonly id: string; readonly pid: number }> {
	const client = await t.client();
	const id = await (await client.get(Sessions, {}, context)).create({ title: "one" }, context);
	const held = await client.get(Probe, { session: id }, context);
	if (held.variant !== "owner") return assert.fail(held.variant);
	const pid = held.pid.value;
	await held.report({ state: "working" }, context);
	await held.busy(1, context);
	held.release();
	return { id, pid };
}

/** Edits the runner plugin's code (a comment would build the same script) and applies until its runner is new. */
async function reloadRunner({ t, builtIn }: EditableServer) {
	const { host } = t.server.runtime;
	const before = (await host.registry(WorkerRunners, context)).value;
	const file = join(builtIn, "runner", "local-runner.ts");
	await writeFile(file, (await readFile(file, "utf8")).replace("the runner closed", "the runner was closed"));
	// The watcher sees the edit a moment after it is written: applied until the runner is a new one.
	return eventually(
		async () => ({
			result: await t.server.runtime.apply(context),
			runner: (await host.registry(WorkerRunners, context)).value,
		}),
		({ runner }) => runner !== undefined && runner !== before,
	);
}

describe("a reload of the runner plugin", () => {
	it("stops the workers, and the waker starts the unheld working session's worker again on the new runner", async () => {
		const editable = await editableServer();
		const { id, pid } = await workingSession(editable.t);
		const { runner } = await reloadRunner(editable);
		assert.ok(!alive(pid), "the old runner stopped its worker");
		const workers = await eventually(
			async () => runner?.state() ?? {},
			(state) => state[id]?.status === "running",
		);
		const restarted = workers[id];
		assert.ok(restarted?.status === "running" && restarted.pid !== pid);
		assert.deepEqual(editable.t.errors, []);
	});

	it("a held session comes back on a new worker, its holder's reference working again without a retry", async () => {
		const editable = await editableServer();
		const { t } = editable;
		const client = await t.client();
		const id = await (await client.get(Sessions, {}, context)).create({ title: "one" }, context);
		const held = await client.get(Probe, { session: id }, context);
		if (held.variant !== "owner") return assert.fail(held.variant);
		const pid = held.pid.value;
		await reloadRunner(editable);
		await until(held.pid, (now) => now !== pid, context, 10_000);
		assert.ok(!alive(pid), "the old runner stopped its worker");
		assert.ok(alive(held.pid.value), "the holder's reference reaches the new worker");
		// A call on the same reference reaches the new worker.
		await held.busy(0, context);
		assert.deepEqual(t.errors, []);
	});

	it("an apply that also changes a worker plugin leaves the new runner's worker on the new worker scripts", async () => {
		const editable = await editableServer();
		const { t } = editable;
		await writeFile(join(t.plugins, "marked.worker.ts"), marked("1"));
		const { id } = await workingSession(t);
		await writeFile(join(t.plugins, "marked.worker.ts"), marked("2"));
		await reloadRunner(editable);
		const held = await (await t.client()).get(Marked, { session: id }, context);
		if (held.variant !== "owner") return assert.fail(held.variant);
		await until(held.mark, (mark) => mark === "2", context);
	});
});
