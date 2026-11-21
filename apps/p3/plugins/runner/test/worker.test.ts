// The runner plugin's worker facet alone (`testPlugin`, which serves the worker's `WorkerRuntime` and `WorkerBusy`): the
// worker stops itself once idle for its idle time, and a method call running on its host keeps it, however long it
// runs, as does an object lingering after its last reference; once they ended, it stops once. The idle time runs on Node's mocked timers: the test moves the clock,
// no case waits for it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	defineFacet,
	local,
	method,
	type P3Principal,
	str,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";

/** The worker's idle time in the test. */
const IDLE_MS = 1000;

/** A method that runs until the test lets it end. */
const Gate = local("test.gate", { version: 1, params: {}, members: { wait: method() } });

/** An object that lingers for `LINGER_MS` after its last reference. */
const Lingering = local("test.lingering", { version: 1, params: { id: str() }, members: { touch: method() } });

/** How long a `Lingering` stays after its last reference: longer than the idle time. */
const LINGER_MS = IDLE_MS * 10;

/** The test's facet: `Gate`, its method ending when `open` settles, `entered` resolved once it runs; `Lingering`. */
function gateFacet(entered: PromiseWithResolvers<void>, open: PromiseWithResolvers<null>) {
	return defineFacet((host) => {
		host.serve(Gate, () => ({
			wait: async () => {
				entered.resolve();
				return open.promise;
			},
		}));
		host.serve(Lingering, () => ({ touch: async () => null }), { linger: LINGER_MS });
	});
}

/** The turns a change on a host takes to reach the idle check (its publication, the watch's call). */
async function turns(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("the runner plugin on a worker", () => {
	let t: TestedPlugin<P3Principal>;
	/** How often the worker's `close` was called. */
	let closes = 0;
	let entered = Promise.withResolvers<void>();
	let open = Promise.withResolvers<null>();

	beforeEach(async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		closes = 0;
		entered = Promise.withResolvers<void>();
		open = Promise.withResolvers<null>();
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "worker",
				session: "s",
				idleMs: IDLE_MS,
				close: () => void closes++,
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

	/** Moves the clock until the worker stopped itself `count` times in all (the check is armed after some turns). */
	async function stops(count: number): Promise<void> {
		for (let i = 0; i < 20 && closes < count; i++) {
			await turns();
			mock.timers.tick(IDLE_MS);
		}
		assert.equal(closes, count);
	}

	it("a call running through the idle time keeps the worker; once it finished, the worker stops once", async () => {
		// Idle from the start: it stops after its idle time.
		await stops(1);
		const call = t.root(async (ctx) => (await ctx.get(Gate, {})).wait(ctx), context);
		await entered.promise;
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		await turns();
		assert.equal(closes, 1, "a running call keeps the worker");
		open.resolve(null);
		await call;
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		assert.equal(closes, 2, "one stop once the call finished");
		assert.deepEqual(t.errors, []);
	});

	// Fable S3, review round 3: leaving lingering objects out of the idle check passed every test.
	it("an object lingering after its last reference keeps the worker; once it ended, the worker stops", async () => {
		await stops(1);
		await t.root(async (ctx) => (await ctx.get(Lingering, { id: "x" })).touch(ctx), context);
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		await turns();
		mock.timers.tick(IDLE_MS * 3);
		assert.equal(closes, 1, "a lingering object keeps the worker");
		mock.timers.tick(LINGER_MS);
		await stops(2);
		assert.deepEqual(t.errors, []);
	});
});
