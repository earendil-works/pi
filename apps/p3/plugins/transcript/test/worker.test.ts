// The transcript plugin's worker facet alone (`testPlugin`), beside a stand-in harness (Durable on the worker's store
// with a faux model, its `submit` the harness's way in) and the harness tests' stand-in server: a reader sees the view
// and pages entries but cannot send, a writer sends and stops (not in an archived session), two readers share one
// follower of the conversation, and a member removed while holding the transcript is denied at once.

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
import { within } from "../../../test/until.ts";
import { sessionRow, standIns } from "../../harness/test/stubs.ts";

const SESSION = "s1";
/** The owner, as the stand-ins answer for them (a person who writes). */
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
		server.access("person:alice", "read");
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

	it("a writer sends and sees the answer; a reader sees it and pages entries, but has no send", async () => {
		await t.root(
			async (ctx) => {
				const writer = await ctx.get(Transcript, { session: SESSION });
				assert.equal(writer.variant, "writer");
				if (writer.variant !== "writer") return;
				await writer.send({ text: "hello", requestId: "r1" }, ctx);
				await until(writer.view, (view) => texts(view).includes("ok: hello"), within("the answer", ctx));
			},
			context,
			{ principal: OWNER },
		);
		await t.root(
			async (ctx) => {
				const reader = await ctx.get(Transcript, { session: SESSION });
				assert.equal(reader.variant, "reader");
				// The reference is typed by its variant; a client's call of `send` anyway is refused by the object.
				const send: unknown = Reflect.get(reader, "send");
				assert.ok(typeof send === "function");
				await assert.rejects(
					async () => Reflect.apply(send, reader, [{ text: "x", requestId: "r2" }, ctx]),
					(error) => isChordError(error) && error.code === "invalid",
				);
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

	it("lets a writer stop, except in an archived session", async () => {
		await t.root(
			async (ctx) => {
				const writer = await ctx.get(Transcript, { session: SESSION });
				if (writer.variant !== "writer") return assert.fail("the owner writes");
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
				const transcript = await ctx.get(Transcript, { session: SESSION });
				await until(transcript.view, (view) => view !== null, within("the view", ctx, 5000));
			},
			context,
			{ principal: OWNER },
		);
		assert.equal(counts.opens, 2);
		const followers = t.errors.filter((error) => JSON.stringify(error).includes("transcript.followed"));
		assert.deepEqual(followers, []);
	});

	it("follows a conversation once for two readers", async () => {
		await t.root(
			async (ctx) => {
				const one = await ctx.get(Transcript, { session: SESSION });
				await t.root(
					async (other) => {
						const two = await other.get(Transcript, { session: SESSION });
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

	it("denies a member removed while holding the transcript", async () => {
		await t.root(
			async (ctx) => {
				const transcript = await ctx.get(Transcript, { session: SESSION });
				assert.equal(transcript.variant, "reader");
				server.access("person:alice", "none");
				const state = await until(transcript.state, (value) => value.kind === "failed", within("the denial", ctx));
				assert.ok(state.kind === "failed" && state.cause.kind === "denied");
				assert.throws(
					() => transcript.view.value,
					(error) => isChordError(error) && error.code === "forbidden",
				);
			},
			context,
			{ principal: ALICE },
		);
	});
});
