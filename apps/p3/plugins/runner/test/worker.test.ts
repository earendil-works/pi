// The runner plugin's worker facet alone (`testPlugin`, which serves the worker's `WorkerRuntime` and `WorkerBusy`): the
// worker stops itself once idle for its idle time, and a method call running on its host keeps it, however long it
// runs; once the call finished, it stops once. The idle time runs on Node's mocked timers: the test moves the clock,
// no case waits for it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, defineFacet, local, method, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";

/** The worker's idle time in the test. */
const IDLE_MS = 1000;

/** A method that runs until the test lets it end. */
const Gate = local("test.gate", { version: 1, params: {}, members: { wait: method() } });

/** The test's facet: `Gate`, its method ending when `open` settles, `entered` resolved once it runs. */
function gateFacet(entered: PromiseWithResolvers<void>, open: PromiseWithResolvers<null>) {
	return defineFacet((host) => {
		host.serve(Gate, () => ({
			wait: async () => {
				entered.resolve();
				return open.promise;
			},
		}));
	});
}

/** The turns a change on a host takes to reach the idle check (its publication, the watch's call). */
async function turns(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("the runner plugin on a worker", () => {
	let t: TestedPlugin<P3Principal>;
	const closed: string[] = [];
	let entered = Promise.withResolvers<void>();
	let open = Promise.withResolvers<null>();

	beforeEach(async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		closed.length = 0;
		entered = Promise.withResolvers<void>();
		open = Promise.withResolvers<null>();
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "worker",
				session: "s",
				idleMs: IDLE_MS,
				close: (reason) => void closed.push(reason),
				stubs: [{ name: "test.gate", facet: gateFacet(entered, open) }],
			},
			context,
		);
	});

	afterEach(async () => {
		open.resolve(null);
		await t.close(context);
		mock.timers.reset();
	});

	it("a call running through the idle time keeps the worker; once it finished, the worker stops once", async () => {
		// Idle from the start: it stops after its idle time (the clock moves until the check is armed).
		for (let i = 0; i < 20 && closed.length === 0; i++) {
			await turns();
			mock.timers.tick(IDLE_MS);
		}
		assert.deepEqual(closed, ["idle"]);
		const call = t.root(async (ctx) => (await ctx.get(Gate, {})).wait(ctx), context);
		await entered.promise;
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		await turns();
		assert.deepEqual(closed, ["idle"], "a running call keeps the worker");
		open.resolve(null);
		await call;
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		assert.deepEqual(closed, ["idle", "idle"], "one stop once the call finished");
		assert.deepEqual(t.errors, []);
	});
});
