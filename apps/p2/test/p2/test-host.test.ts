// Bare-host examples: real facet declarations, stubbed dependencies, memory-linked principals and live assertions.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { DraftStore, Drafts } from "../../plugins/drafts/contract.ts";
import draftsWorker from "../../plugins/drafts/worker.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import statusServer from "../../plugins/status/server.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import workspaceWorker from "../../plugins/workspace/worker.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { Session } from "../../src/runtime/chord.ts";
import { Hosts, type WorkerState } from "../../src/runtime/server.ts";
import { type HarnessParts, Liveness, SessionLocation, type WorkerParts } from "../../src/runtime/worker.ts";
import {
	ChordError,
	expectChord,
	type Followed,
	holdIn,
	poll,
	settled,
	testHost,
	until,
	workerFacet,
} from "./helpers.ts";

const OWNER = { kind: "owner", access: "local" } as const;
const ALICE = {
	kind: "guest",
	id: "alice",
	name: "Alice",
	home: "sample",
	sessions: { sample: "full" },
	revision: 1,
} as const;

describe("testHost", () => {
	it("runs a worker facet in a bare session host and checks guest variants over memory links", async (t) => {
		const fixture = await testHost({ address: Session({ id: "sample" }), kind: "worker", facets: [draftsWorker] });
		t.after(() => fixture.close());
		await fixture.root(async (ctx) => {
			await (await ctx.get(DraftStore, {})).add(
				{
					conversation: 1,
					items: [
						{ author: { kind: "owner", id: "owner", name: "Owner" }, text: "owner draft" },
						{ author: { kind: "guest", id: ALICE.id, name: ALICE.name }, text: "alice draft" },
					],
				},
				ctx,
			);
		});
		const alice = fixture.client(ALICE).hold(Drafts, { session: "sample", conversation: 1 }, BACKGROUND_CONTEXT);
		await whenLive(alice);
		assert.equal(alice.variant, "author");
		const drafts = await settled(alice.drafts);
		assert.deepEqual(
			drafts.map((draft) => draft.text),
			["alice draft"],
		);
		assert.deepEqual(await alice.claim({ ids: drafts.map((draft) => draft.id) }, BACKGROUND_CONTEXT), {
			texts: ["alice draft"],
		});
		assert.deepEqual(await settled(alice.drafts), []);
		const viewer = fixture
			.client({ ...ALICE, sessions: { sample: "view" }, revision: 2 })
			.hold(Drafts, { session: "sample", conversation: 1 }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(viewer), "forbidden");
		const foreign = fixture
			.client({ ...ALICE, id: "foreign", home: "other", sessions: { other: "full" } })
			.hold(Drafts, { session: "sample", conversation: 1 }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(foreign), "forbidden");
	});

	it("tests the status facet with a Hosts stub, generation fences and guest-scoped state", async (t) => {
		let publish!: (ctx: Ctx, workers: Record<string, WorkerState>) => void;
		const fixture = await testHost({
			facets: [statusServer],
			stubs: [
				[
					Hosts,
					(_input, _principal, self) => {
						const workersState = self.state({});
						publish = (ctx, workers) => workersState.replace(ctx, workers);
						return { workers: workersState, stop: () => {} };
					},
				],
			],
		});
		t.after(() => fixture.close());
		const owner = await holdIn(fixture.client(OWNER), SessionStatus, {}, "reader");
		await fixture.root((ctx) =>
			publish(ctx, { sample: { running: true, generation: 2 }, other: { running: true, generation: 1 } }),
		);
		await until(owner.statuses, (value) => value?.sample?.running === true);
		const worker = await holdIn(
			fixture.client({ kind: "worker", session: "sample", generation: 2 }),
			SessionStatus,
			{},
			"reporter",
		);
		await worker.report({ tasks: 3, busy: [4, 1] }, BACKGROUND_CONTEXT);
		await until(owner.statuses, (value) => value?.sample?.tasks === 3);
		const stale = await holdIn(
			fixture.client({ kind: "worker", session: "sample", generation: 1 }),
			SessionStatus,
			{},
			"reporter",
		);
		await stale.report({ tasks: 99, busy: [99] }, BACKGROUND_CONTEXT);
		assert.deepEqual((await settled(owner.statuses)).sample, { running: true, tasks: 3, busy: [1, 4] });
		const guest = await holdIn(
			fixture.client({ ...ALICE, sessions: { sample: "view" } }),
			SessionStatus,
			{},
			"reader",
		);
		assert.deepEqual(Object.keys(await settled(guest.statuses)), ["sample"]);
		const anonymous = fixture.client({ kind: "anonymous" } as never).hold(SessionStatus, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(anonymous), "forbidden");
		await fixture.root((ctx) =>
			publish(ctx, { sample: { running: false, generation: 2 }, other: { running: true, generation: 1 } }),
		);
		await until(owner.statuses, (value) => value?.sample?.running === false);
		assert.deepEqual((await settled(guest.statuses)).sample, { running: false, tasks: 0, busy: [] });
		await fixture.root((ctx) =>
			publish(ctx, { sample: { running: false, generation: 2, error: "worker fixture failure" } }),
		);
		await until(owner.statuses, (value) => value?.sample?.error === "worker fixture failure");
		// Guests learn that it stopped, never the worker's error text (paths, stacks), as in Pi Mobile.
		assert.deepEqual((await settled(guest.statuses)).sample, { running: false, tasks: 0, busy: [] });
		await fixture.root((ctx) => publish(ctx, { sample: { running: true, generation: 3 } }));
		await until(owner.statuses, (value) => value?.sample?.running === true && value.sample.error === undefined);
	});
});

it("a workspace hold protects a slow watch activation, and releases its liveness lease", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "p2-watch-unit-"));
	const project = join(root, "project");
	const dataDir = join(root, "data");
	await Promise.all([mkdir(project), mkdir(dataDir)]);
	const env = new NodeExecutionEnv({ cwd: project });
	let unblock!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const watching = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const watch = env.watch.bind(env);
	env.watch = async (...args) => {
		entered();
		await blocked;
		return watch(...args);
	};
	let viewers = 0;
	const liveness = new Liveness();
	follow(liveness, (counts) => {
		viewers = counts.viewers ?? 0;
	});
	const fixture = await testHost({
		address: Session({ id: "sample" }),
		kind: "worker",
		facets: [
			workerFacet({
				harness: {
					durable: {
						conversation: async () => ({ agent: async () => ({}) }),
						observeCommits: () => ({ detach: () => {} }),
					},
					environments: {
						session: { cwd: project, env: null },
						locate: async () => ({ cwd: project, env: null }),
						at: async () => env,
					},
					relocate: async () => {},
				} as unknown as HarnessParts,
				worker: {
					init: {
						dataDir,
						fake: true,
						generation: 1,
						plugins: [],
						values: {
							session: {
								id: "sample",
								cwd: project,
								env: null,
								model: { provider: "faux", modelId: "faux-1" },
								thinkingLevel: "high",
							},
						},
					} as unknown as WorkerParts["init"],
					liveness,
					location: new SessionLocation({ cwd: project, env: null }),
				},
			}),
			workspaceWorker,
		],
	});
	t.after(async () => {
		unblock();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	const workspace = fixture.client(OWNER).hold(Workspace, { session: "sample", conversation: 1 }, BACKGROUND_CONTEXT);
	await Promise.race([watching, whenLive(workspace)]);
	assert.equal(viewers, 1, "activation is held work even before FileSystem.watch returns");
	unblock();
	await whenLive(workspace);
	workspace.release();
	await poll(() => viewers === 0, 5000, "workspace activation lease released");
});

describe("live assertion helpers", () => {
	it("settles the latest publication and unsubscribes on success and timeout", async () => {
		let value: number | undefined;
		const listeners = new Set<(value: number | undefined) => void>();
		// A native watchable by hand: each watch is one listener until its context aborts.
		const readable: Followed<number | undefined> = {
			get value() {
				return value;
			},
			watch: async (context) => {
				let next: ((call: { kind: "value"; value: number | undefined }) => Promise<void>) | undefined;
				const listener = (current: number | undefined) => void next?.({ kind: "value", value: current });
				listeners.add(listener);
				const closed = Promise.withResolvers<{ kind: "aborted" | "stopped" }>();
				const end = (kind: "aborted" | "stopped") => {
					listeners.delete(listener);
					closed.resolve({ kind });
				};
				context.abortSignal?.addEventListener("abort", () => end("aborted"), { once: true });
				return {
					get value() {
						return value;
					},
					start: (fn: typeof next) => {
						next = fn;
					},
					stop: async () => {
						end("stopped");
						return { kind: "stopped" as const };
					},
					closed: closed.promise,
				} as never;
			},
		};
		const emit = (next: number | undefined) => {
			value = next;
			for (const listener of listeners) listener(next);
		};
		const promise = settled(readable, 5);
		emit(1);
		emit(2);
		assert.equal(await promise, 2);
		assert.equal(listeners.size, 0);
		await assert.rejects(
			until(readable, (value) => value === 3, 5),
			/timed out/,
		);
		assert.equal(listeners.size, 0);
		emit(undefined);
		await assert.rejects(settled(readable, 5, 10), /did not settle/);
		assert.equal(listeners.size, 0);
	});

	it("asserts ChordError codes and returns the error for reason/details checks", async () => {
		const expected = new ChordError({ code: "forbidden", message: "no grant" });
		assert.equal(await expectChord(Promise.reject(expected), "forbidden"), expected);
		await assert.rejects(expectChord(Promise.resolve(null), "forbidden"), /promise resolved/);
		await assert.rejects(
			expectChord(Promise.reject(new Error("not chord")), "forbidden"),
			/expected ChordError forbidden/,
		);
	});
});
