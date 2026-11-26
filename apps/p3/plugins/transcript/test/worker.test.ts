// The transcript plugin's worker facet alone (`testPlugin`), beside a stand-in harness (Durable on the worker's store
// with a faux model, its `submit` the harness's way in) and the harness tests' stand-in server, which answers each
// caller's ticks on the session: Read sees the view and pages entries, Send sends, Stop stops (not in an archived
// session); Read without Send has no send, Send without Read no view; two readers share one follower of the
// conversation, and a caller given nothing any more while holding the transcript is denied at once.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	contribute,
	defineFacet,
	isChordError,
	type P3Principal,
	Transcript,
	until,
	withGranted,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import {
	type ConversationView,
	createModels,
	createRegistry,
	fauxAssistantMessage,
	fauxProvider,
	Harness,
	type OpenHarness,
	SessionHarness,
	StoreStorage,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { assertGranted } from "../../../test/granted.ts";
import { within } from "../../../test/until.ts";
import { sessionRow, standIns } from "../../harness/test/stubs.ts";

const SESSION = "s1";

/** Every member of the transcript: the owner has every tick of the session. */
const ALL = ["view", "entries", "send", "stop"] as const;
/** The owner, as the stand-ins answer for them (every tick of the session). */
const OWNER: P3Principal = { kind: "person", id: "owner", name: "Owner" };
const ALICE: P3Principal = { kind: "person", id: "alice", name: "Alice" };

/**
 * A stand-in harness: Durable on the worker's store answering "ok", counting the followers of conversations. With
 * `opens`, its first open fails and it opens on its retry (a second later), so it is not open yet after the load.
 */
function standInHarness(counts: { observers: number; opens?: number }) {
	return defineFacet((host) => {
		host.serve(SessionHarness, { compose: (table) => table[0]?.value });
		contribute(host, "test.harness", (self) => {
			const runtime = self.registry(WorkerRuntime);
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
			const opened = self.open(
				async (open) => {
					if (counts.opens !== undefined && counts.opens++ === 0) throw new Error("the first open fails");
					const models = createModels();
					models.setProvider(faux.provider);
					const storage = await StoreStorage.open(runtime.value.store, "harness", open);
					const durable = await Harness.open(storage, { models, registry: createRegistry() }, open);
					await durable.root(open, { agent: { model: { provider: "faux", modelId: "faux-model" } } });
					durable.resume();
					return durable;
				},
				(durable, _reason, close) => durable.close(close),
			);
			const harness: OpenHarness = {
				get durable() {
					// Counts the follows; every other member is Durable's own, on Durable.
					return new Proxy(opened.value, {
						get: (target, key) => {
							if (key === "observeConversation") counts.observers++;
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
				submit: async (_conversation, { text, requestId }, ctx) => {
					faux.appendResponses([fauxAssistantMessage(`ok: ${text}`)]);
					const root = await opened.value.root(ctx);
					await root.submit({ type: "input", content: text, requestId }, ctx);
				},
			};
			self.contribute(SessionHarness, harness);
		});
	});
}

/** The texts of the view's entries: each entry's `data.text` or its model message's text. */
function texts(view: unknown): string[] {
	const entries = (view as ConversationView | null)?.entries ?? [];
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (message === undefined || message.role === "system") return [];
		const content = message.content;
		return [
			typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		];
	});
}

describe("the transcript plugin on a worker", () => {
	let t: TestedPlugin<P3Principal>;
	let counts: { observers: number; opens?: number };
	let server: ReturnType<typeof standIns>["control"];

	beforeEach(async (c) => {
		// The case about a harness not open yet: its first open fails.
		counts = c.name.includes("not open yet") ? { observers: 0, opens: 0 } : { observers: 0 };
		const stand = standIns(sessionRow(SESSION, "/tmp"), []);
		server = stand.control;
		server.ticks("person:alice", ["read"]);
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "worker",
				session: SESSION,
				stubs: [{ name: "test.harness", facet: standInHarness(counts) }],
				server: stand.server,
			},
			context,
		);
	});

	afterEach(() => t.close(context));

	it("Send sends and Read sees the answer; Read alone pages entries but has no send", async () => {
		await t.root(
			async (ctx) => {
				const writer = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
				assertGranted(writer, ...ALL);
				await writer.send({ text: "hello", requestId: "r1" }, ctx);
				await until(writer.view, (view) => texts(view).includes("ok: hello"), within("the answer", ctx));
			},
			context,
			{ principal: OWNER },
		);
		await t.root(
			async (ctx) => {
				const held = await ctx.get(Transcript, { session: SESSION });
				// Not granted `send`: the reference has none (a call over the wire anyway is refused `forbidden` by Chord).
				assert.equal(held.send, undefined);
				const reader = withGranted(held, "view", "entries")!;
				assert.deepEqual(texts(reader.view.value), ["hello", "ok: hello"]);
				const page = await reader.entries({ limit: 1 }, ctx);
				assert.equal(page.items.length, 1);
				assert.equal(page.more, true);
			},
			context,
			{ principal: ALICE },
		);
		assert.deepEqual(t.errors, []);
	});

	// ERNDL-704 test 4: Send without Read (a row of its own): the composer only.
	it("gives Send without Read the send and no view", async () => {
		server.ticks("person:alice", ["send"]);
		await t.root(
			async (ctx) => {
				const held = await ctx.get(Transcript, { session: SESSION });
				assert.deepEqual([...held.granted].sort(), ["send"]);
				assert.equal(held.view, undefined);
				assert.equal(held.entries, undefined);
				assert.equal(await withGranted(held, "send")!.send({ text: "hi", requestId: "r2" }, ctx), null);
			},
			context,
			{ principal: ALICE },
		);
	});

	it("lets Stop stop, except in an archived session", async () => {
		await t.root(
			async (ctx) => {
				const writer = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
				assert.equal(await writer.stop(ctx), null);
				server.row({ archivedAt: 5 });
				await until(writer.state, (state) => state.kind === "live", within("the writer", ctx));
				await assert.rejects(writer.stop(ctx), (error) => isChordError(error) && error.code === "forbidden");
			},
			context,
			{ principal: OWNER },
		);
	});

	// Bench, 2026-11-22: a reader who came before the harness was open failed the follower's first attempt
	// (`activation_failed`, "the followed address is absent"), retried once the harness was contributed.
	it("waits for a harness that is not open yet, without a failed attempt", async () => {
		await t.root(
			async (ctx) => {
				const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
				await until(transcript.view, (view) => view !== null, within("the view", ctx, 5000));
			},
			context,
			{ principal: OWNER },
		);
		assert.equal(counts.opens, 2);
		const followers = t.errors.filter((error) => JSON.stringify(error).includes("transcript.followed"));
		assert.deepEqual(followers, []);
	});

	// Astra, round 2 (must 2).
	it("lets Send alone wait for a harness that is not open yet, without a reader", async () => {
		server.ticks("person:alice", ["send"]);
		await t.root(
			async (ctx) => {
				const writer = withGranted(await ctx.get(Transcript, { session: SESSION }), "send")!;
				assert.equal(
					await writer.send({ text: "hi", requestId: "cold-send" }, within("the harness", ctx, 5000)),
					null,
				);
			},
			context,
			{ principal: ALICE },
		);
		assert.equal(counts.observers, 0);
	});

	it("follows a conversation once for two readers", async () => {
		await t.root(
			async (ctx) => {
				const one = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
				await t.root(
					async (other) => {
						const two = withGranted(await other.get(Transcript, { session: SESSION }), "view")!;
						assert.deepEqual(one.view.value, two.view.value);
					},
					context,
					{ principal: ALICE },
				);
			},
			context,
			{ principal: OWNER },
		);
		assert.equal(counts.observers, 1);
	});

	it("denies a caller given nothing any more while holding the transcript", async () => {
		await t.root(
			async (ctx) => {
				const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
				assert.equal(transcript.granted.has("send"), false);
				server.ticks("person:alice", null);
				const state = await until(transcript.state, (value) => value.kind === "failed", within("the denial", ctx));
				assert.ok(state.kind === "failed" && state.cause.kind === "denied");
				// Nothing granted any more: no view to read.
				assert.equal(transcript.view, undefined);
			},
			context,
			{ principal: ALICE },
		);
	});

	// Astra, round 1 (should 7).
	it("opens no reader of the conversation for a holder with Send only", async () => {
		server.ticks("person:alice", ["send"]);
		await t.root(
			async (ctx) => {
				const held = withGranted(await ctx.get(Transcript, { session: SESSION }), "send")!;
				assert.equal(await held.send({ text: "hi", requestId: "send-only" }, ctx), null);
				assert.equal(counts.observers, 0);
			},
			context,
			{ principal: ALICE },
		);
	});

	// Opus, round 1: a tick gained or lost changes the grant on the same hold.
	it("grants Send on the same hold once it is given, and takes the view once Read is withheld", async () => {
		await t.root(
			async (ctx) => {
				const held = await ctx.get(Transcript, { session: SESSION });
				assert.equal(held.send, undefined);
				server.ticks("person:alice", ["read", "send"]);
				await until(held.state, () => held.granted.has("send"), within("Send given", ctx));
				server.ticks("person:alice", ["send"]);
				await until(held.state, () => !held.granted.has("view"), within("Read withheld", ctx));
				assert.equal(held.granted.has("send"), true);
			},
			context,
			{ principal: ALICE },
		);
	});

	// Opus, round 2: an answer on a workspace that is no session (a plain workspace) admits nothing on its worker.
	it("denies a caller whose answer is on a workspace of another kind", async () => {
		server.ticks("person:alice", ["read"], "things.workspace");
		await t.root(
			async (ctx) => {
				const held = await ctx
					.get(Transcript, { session: SESSION }, { readyTimeout: 1000 })
					.catch((error) => error);
				assert.ok(isChordError(held) && held.code === "forbidden", String(held));
			},
			context,
			{ principal: ALICE },
		);
	});
});
