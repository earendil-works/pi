// The backup plugin on a session's worker (plugin tier): the store's outbox is turned on once the session is backed up,
// and stays on when backup is turned off (the session is only paused). A stand-in server serves `SessionBackup` with an
// `enabled` the test sets.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bool, BACKGROUND_CONTEXT as context, defineFacet, local, method, remote, Server } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { eventually } from "../../../test/until.ts";
import { SessionBackup } from "../contract.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** The test's switch on the stand-in server: what `SessionBackup.enabled` shows. */
const Switch = remote("backup-test.switch", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	methods: { set: method(bool()) },
});

/** Where the stand-in keeps the switch's value. */
const Value = local("backup-test.value", {
	version: 1,
	params: {},
	members: { enabled: bool(), set: method(bool()) },
});

/** A stand-in server: `SessionBackup` for any worker, its `enabled` set through `Switch`. */
const standIn = defineFacet((host) => {
	host.serve(Value, (_params, self) => {
		const enabled = self.writable<boolean>(false);
		return {
			enabled: self.derive([enabled], ([value]) => value),
			set: async (on: boolean) => {
				enabled.set(on);
				return null;
			},
		};
	});
	host.serve(Switch, (_params, _principal, self) => {
		const value = self.get(Value, {});
		return { set: (on, ctx) => value.set(on, ctx) };
	});
	host.serve(SessionBackup, (_params, _principal, self) => ({
		enabled: self.get(Value, {}).enabled,
		report: async () => null,
	}));
});

/** The plugin's worker facet on session `s1`, linked to the stand-in server. */
async function withWorkerFacet(test: (t: Awaited<ReturnType<typeof testPlugin>>) => Promise<void>): Promise<void> {
	const t = await testPlugin(
		PLUGIN,
		{ kind: "worker", session: "s1", server: [{ name: "backup-test", facet: standIn }] },
		context,
	);
	try {
		await test(t);
	} finally {
		await t.close(context);
	}
}

/** Sets what the stand-in's `SessionBackup.enabled` shows. */
async function setEnabled(t: Awaited<ReturnType<typeof testPlugin>>, on: boolean): Promise<void> {
	await t.root(async (ctx) => (await ctx.get(Switch, {})).set(on, ctx), context);
}

/** Whether the session store records an outbox now. */
async function outboxOn(t: Awaited<ReturnType<typeof testPlugin>>): Promise<boolean> {
	return (await t.host.registry(WorkerRuntime, context)).value.store.outbox !== undefined;
}

/** Every `on` the worker passes to its store's `setOutbox`, in order, from now on. */
async function recordSetOutbox(t: Awaited<ReturnType<typeof testPlugin>>): Promise<boolean[]> {
	const store = (await t.host.registry(WorkerRuntime, context)).value.store;
	const setOutbox = store.setOutbox.bind(store);
	const calls: boolean[] = [];
	store.setOutbox = (on, ctx) => {
		calls.push(on);
		return setOutbox(on, ctx);
	};
	return calls;
}

/** What `SessionBackup.enabled` shows on the worker now. */
async function enabledOnWorker(t: Awaited<ReturnType<typeof testPlugin>>): Promise<boolean> {
	return t.root(async (ctx) => (await ctx.get(SessionBackup, {})).enabled.value, context);
}

describe("the session store's outbox", () => {
	it("is off until the session is backed up, then on", async () => {
		await withWorkerFacet(async (t) => {
			assert.equal(await outboxOn(t), false);
			await setEnabled(t, true);
			assert.equal(
				await eventually(
					() => outboxOn(t),
					(on) => on,
				),
				true,
			);
		});
	});

	it("is never turned off when backup is turned off: the session is only paused", async () => {
		await withWorkerFacet(async (t) => {
			const calls = await recordSetOutbox(t);
			await setEnabled(t, true);
			await eventually(
				() => calls.length,
				(count) => count === 1,
			);
			await setEnabled(t, false);
			// The worker saw `false` once its own reference shows it: the facet's reference is on the same link.
			await eventually(
				() => enabledOnWorker(t),
				(on) => !on,
			);
			await setEnabled(t, true);
			await eventually(
				() => calls.length,
				(count) => count >= 2,
			);
			assert.deepEqual(calls, [true, true]);
		});
	});
});
