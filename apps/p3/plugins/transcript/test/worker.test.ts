// The transcript plugin's worker facet alone (`testPlugin`), beside a stand-in harness (Durable on the worker's store
// with a faux model, its `submit` the harness's way in) and the harness tests' stand-in server, which answers each
// caller's ticks on the session: Read sees the view and pages entries, Send sends, Stop stops (not in an archived
// session); Read without Send has no send, Send without Read no view; two readers share one follower of the
// conversation, which follows it across a harness replaced while it is held (a reload of the harness plugin) failing
// nothing; and a caller given nothing any more while holding the transcript is denied at once.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	contribute,
	createHost,
	defineFacet,
	type Host,
	isChordError,
	memoryLinkPair,
	type P3Principal,
	Transcript,
	until,
	type Writable,
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
import { collected, eventually, within } from "../../../test/until.ts";
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

/**
 * How a case drives `swappableHarness`: `swap` replaces the harness; `attached`, set by the case, runs after each
 * observation of a conversation attached and before its follower gets it, with the count of harnesses opened so far
 * and the one observed.
 */
type Swap = { swap?: () => Promise<void>; attached?: (opens: number, harness: OpenHarness) => Promise<void> };

/**
 * A stand-in harness that `swap` replaces as a reload of the harness plugin does: its contribution withdrawn first,
 * then its Durable closed (which ends the observers it had), then a new one opened on the store and contributed.
 */
function swappableHarness(control: Swap) {
	return defineFacet((host) => {
		host.serve(SessionHarness, { compose: (table) => table[0]?.value });
		contribute(host, "test.harness", (self) => {
			const runtime = self.registry(WorkerRuntime);
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
			const given = self.writable<OpenHarness | undefined>(undefined);
			// The registry composes its first entry's value: `undefined` stands for the contribution withdrawn.
			self.contribute(SessionHarness, given as Writable<OpenHarness>);
			let durable: Harness | undefined;
			let opens = 0;
			const open = async (ctx: typeof context): Promise<OpenHarness> => {
				const models = createModels();
				models.setProvider(faux.provider);
				const storage = await StoreStorage.open(runtime.value.store, "harness", ctx);
				const opened = await Harness.open(storage, { models, registry: createRegistry() }, ctx);
				await opened.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-model" } } });
				opened.resume();
				durable = opened;
				const count = ++opens;
				const harness: OpenHarness = {
					durable: new Proxy(opened, {
						get: (target, key) => {
							const value = Reflect.get(target, key, target);
							if (typeof value !== "function") return value;
							if (key !== "observeConversation") return value.bind(target);
							return async (...args: unknown[]) => {
								const observation = await Reflect.apply(value, target, args);
								await control.attached?.(count, harness);
								return observation;
							};
						},
					}),
					submit: async (_conversation, { text, requestId }, call) => {
						faux.appendResponses([fauxAssistantMessage(`ok: ${text}`)]);
						await (await opened.root(call)).submit({ type: "input", content: text, requestId }, call);
					},
				};
				return harness;
			};
			self.open(
				async (ctx) => {
					given.set(await open(ctx));
					return null;
				},
				async (_none, _reason, ctx) => durable?.close(ctx),
			);
			control.swap = async () => {
				given.set(undefined);
				await durable?.close(context);
				given.set(await open(context));
			};
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

	// Astra, slice 5 round 1 (should 8): the old Durable's "session closed" failed the follower (`object_failed`).
	it("follows the conversation across a harness replaced while held, failing nothing", async () => {
		const control: Swap = {};
		const swapped = await swappable(control);
		try {
			await swapped.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
					await transcript.send({ text: "one", requestId: "one" }, ctx);
					await until(transcript.view, (view) => texts(view).includes("ok: one"), within("the first answer", ctx));
					await control.swap?.();
					await transcript.send({ text: "two", requestId: "two" }, ctx);
					await until(
						transcript.view,
						(view) => texts(view).includes("ok: two"),
						within("the next harness's answer", ctx),
					);
					assert.equal(transcript.state.value.kind, "live");
				},
				context,
				{ principal: OWNER },
			);
			assert.deepEqual(swapped.errors, []);
		} finally {
			await swapped.close(context);
		}
	});
	// Fable, round 1: a harness replaced while the follower's first observation attached was never followed.
	it("follows the next harness when the harness is replaced while the first observation attaches", async () => {
		const control: Swap = {};
		control.attached = async (opens) => {
			if (opens === 1) await control.swap!();
		};
		const swapped = await swappable(control);
		try {
			await swapped.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
					await transcript.send({ text: "two", requestId: "two" }, ctx);
					await until(
						transcript.view,
						(view) => texts(view).includes("ok: two"),
						within("the next harness's answer", ctx),
					);
				},
				context,
				{ principal: OWNER },
			);
			assert.deepEqual(swapped.errors, []);
		} finally {
			await swapped.close(context);
		}
	});

	// Fable, round 1: Durable may call an observer before `observeConversation` resolves; on the next harness those
	// calls were applied to the old view and then lost under the replacement.
	it("keeps what the next harness commits while its observation attaches", async () => {
		const control: Swap = {};
		const handed = Promise.withResolvers<void>();
		control.attached = async (opens, harness) => {
			if (opens !== 2) return;
			await harness.submit(undefined, { text: "early", requestId: "early" }, context);
			const root = await harness.durable.root(context);
			await eventually(
				async () => texts({ entries: (await root.entries({ order: "ascending" }, 50, undefined, context)).items }),
				(seen) => seen.includes("ok: early"),
			);
			// Resolved once the follower got this observation and gave its view.
			setTimeout(handed.resolve, 50);
		};
		const swapped = await swappable(control);
		try {
			await swapped.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
					await transcript.send({ text: "one", requestId: "one" }, ctx);
					await until(transcript.view, (view) => texts(view).includes("ok: one"), within("the first answer", ctx));
					await control.swap?.();
					await until(
						transcript.view,
						(view) => texts(view).includes("ok: early"),
						within("the early answer", ctx),
					);
					await handed.promise;
					assert.deepEqual(texts(transcript.view.value), ["one", "ok: one", "early", "ok: early"]);
				},
				context,
				{ principal: OWNER },
			);
			assert.deepEqual(swapped.errors, []);
		} finally {
			await swapped.close(context);
		}
	});
	// Fable, round 1: a next harness whose observation rejected left the follower on the old view for good.
	it("fails the follow when the next harness cannot be observed, and follows it on the retry", async () => {
		const control: Swap = {};
		let refused = false;
		control.attached = async (opens) => {
			if (opens !== 2 || refused) return;
			refused = true;
			throw new Error("no observation");
		};
		const swapped = await swappable(control);
		try {
			await swapped.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), ...ALL)!;
					await control.swap?.();
					await transcript.send({ text: "two", requestId: "two" }, ctx);
					await until(
						transcript.view,
						(view) => texts(view).includes("ok: two"),
						within("the next harness's answer", ctx, 10_000),
					);
				},
				context,
				{ principal: OWNER },
			);
			assert.deepEqual(
				swapped.errors.map((error) => error.kind),
				["object_failed"],
			);
		} finally {
			await swapped.close(context);
		}
	});
});

/** The transcript plugin on a worker of its own beside `swappableHarness(control)`. */
function swappable(control: Swap): Promise<TestedPlugin<P3Principal>> {
	return testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "worker",
			session: SESSION,
			stubs: [{ name: "test.harness", facet: swappableHarness(control) }],
			server: standIns(sessionRow(SESSION, "/tmp"), []).server,
		},
		context,
	);
}

const PLUGIN = fileURLToPath(new URL("../", import.meta.url));
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function textsOf(view: unknown) {
	return (
		(view as ConversationView | null)?.entries
			.map((e) => e.model?.[0]?.content)
			.flatMap((s) =>
				typeof s === "string" ? [s] : (s ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])),
			) ?? []
	);
}

class Control {
	gate?: { when: "before" | "after"; entered: PromiseWithResolvers<void>; ready: PromiseWithResolvers<void> };
	holdEnd = false;
	lateEnd?: () => void;
	close!: () => Promise<void>;
	open!: () => Promise<void>;
	say!: (text: string) => Promise<void>;
	weak?: WeakRef<OpenHarness>;
	starts = 0;
	detaches = 0;
	frames = 0;
	closeGiven!: () => Promise<void>;
	async swap() {
		await this.close();
		await this.open();
	}
	delay(when: "before" | "after") {
		this.gate = { when, entered: Promise.withResolvers<void>(), ready: Promise.withResolvers<void>() };
		return this.gate;
	}
}

function facet(c: Control) {
	return defineFacet((host) => {
		host.serve(SessionHarness, { compose: (table) => table[0]?.value });
		contribute(host, "test.swap", (self) => {
			const runtime = self.registry(WorkerRuntime);
			const given = self.writable<OpenHarness | undefined>(undefined);
			self.contribute(SessionHarness, given as Writable<OpenHarness>);
			let active: Harness | undefined;
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
			c.closeGiven = async () => active?.close(context);
			c.close = async () => {
				given.set(undefined);
				const old = active;
				active = undefined;
				await old?.close(context);
			};
			c.open = async () => {
				const models = createModels();
				models.setProvider(faux.provider);
				const storage = await StoreStorage.open(runtime.value.store, "harness", context);
				const h = await Harness.open(storage, { models, registry: createRegistry() }, context);
				await h.root(context, { agent: { model: { provider: "faux", modelId: "faux-model" } } });
				h.resume();
				active = h;
				const observed = new Proxy(h, {
					get(target, key) {
						if (key === "observeConversation")
							return async (...[id, obs, ctx]: Parameters<Harness["observeConversation"]>) => {
								c.starts++;
								const g = c.gate;
								c.gate = undefined;
								if (g?.when === "before") {
									g.entered.resolve();
									await g.ready.promise;
								}
								const sub = await h.observeConversation(
									id,
									{
										advance: (v, x) => {
											c.frames++;
											obs.advance(v, x);
										},
										end: (end) => {
											if (c.holdEnd) c.lateEnd = () => obs.end(end);
											else obs.end(end);
										},
									},
									ctx,
								);
								if (g?.when === "after") {
									g.entered.resolve();
									await g.ready.promise;
								}
								return {
									value: sub.value,
									detach() {
										c.detaches++;
										sub.detach();
									},
								};
							};
						const val = Reflect.get(target, key, target);
						return typeof val === "function" ? val.bind(target) : val;
					},
				});
				const wrapped: OpenHarness = {
					durable: observed,
					submit: async (_conversation, input, ctx) => {
						faux.appendResponses([fauxAssistantMessage(`ok: ${input.text}`)]);
						await (await h.root(ctx)).submit(
							{ type: "input", content: input.text, requestId: input.requestId },
							ctx,
						);
					},
				};
				c.weak = new WeakRef(wrapped);
				given.set(wrapped);
			};
			c.say = async (text) => {
				faux.appendResponses([fauxAssistantMessage(`ok: ${text}`)]);
				await (await active!.root(context)).submit({ type: "input", content: text, requestId: text }, context);
				await active!.waitForIdle(context);
			};
			self.open(
				async () => {
					await c.open();
					return null;
				},
				async () => active?.close(context),
			);
		});
	});
}

describe("the follower across harnesses, raced at the observation's attachment (Astra, round 1 of the follower)", () => {
	let c: Control;
	let t: TestedPlugin<P3Principal>;
	let linked: Host<P3Principal>;
	beforeEach(async () => {
		c = new Control();
		const stand = standIns(sessionRow(SESSION, "/tmp"), []);
		stand.control.ticks("worker:s1", ["read"]);
		t = await testPlugin(
			PLUGIN,
			{ kind: "worker", session: SESSION, stubs: [{ name: "test.harness", facet: facet(c) }], server: stand.server },
			context,
		);
		linked = createHost<P3Principal>({
			principal: OWNER,
			readyTimeout: 1500,
			onError: (error) => console.error(error),
		});
		const [up, down] = memoryLinkPair();
		linked.connect(up, { principal: { kind: "worker", session: SESSION }, trusted: true }, context);
		t.host.accept(down, { principal: OWNER }, context);
		await linked.load([], context);
	});
	afterEach(async () => {
		await linked.close(context);
		await t.close(context);
	});
	const read = async () =>
		withGranted(await linked.get(Transcript, { session: SESSION }, within("reader", context, 2000)), "view")!;

	it("replacement completing during the first attach is not lost", async () => {
		const g = c.delay("after");
		const reader = read();
		await g.entered.promise;
		await c.swap();
		await c.say("fresh");
		g.ready.resolve();
		const ref = await reader;
		await until(
			ref.view,
			(v) => textsOf(v).includes("ok: fresh"),
			within(`harness B observed (starts ${c.starts})`, context, 450),
		);
	});

	it("a new frame before the replacement attachment resolves survives its snapshot", async () => {
		const ref = await read();
		const local = withGranted(await t.host.get(Transcript, { session: SESSION }, context), "view")!;
		const g = c.delay("after");
		await c.swap();
		await g.entered.promise;
		await c.say("newlet");
		await turn();
		g.ready.resolve();
		await turn();
		await turn();
		assert.deepEqual(
			{ linked: textsOf(ref.view.value), local: textsOf(local.view.value) },
			{ linked: ["newlet", "ok: newlet"], local: ["newlet", "ok: newlet"] },
		);
	});

	it("a superseded attach rejecting does not prevent the third harness", async () => {
		const ref = await read();
		const g = c.delay("before");
		await c.swap();
		await g.entered.promise;
		await c.swap();
		g.ready.resolve();
		await c.say("third");
		await turn();
		await turn();
		assert.deepEqual(
			{ starts: c.starts, texts: textsOf(ref.view.value), errors: t.errors.map((e) => e.kind) },
			{ starts: 3, texts: ["third", "ok: third"], errors: [] },
		);
	});

	it("holding the last view without a replacement does not pin the withdrawn harness", async () => {
		const ref = await read();
		await c.say("prior");
		await until(ref.view, (v) => textsOf(v).includes("ok: prior"), within("prior", context));
		const old = c.weak!;
		await c.close();
		const whileHeld = await collected([old]);
		assert.ok(textsOf(ref.view.value).includes("ok: prior"));
		await ref.release();
		await turn();
		const afterRelease = await collected([old]);
		assert.deepEqual({ whileHeld, afterRelease }, { whileHeld: true, afterRelease: true });
	});

	it("dropping the only reader during its first attach detaches the resulting observation", async () => {
		const g = c.delay("after");
		const ref = t.host.hold(Transcript, { session: SESSION }, context);
		await g.entered.promise;
		const released = ref.release();
		await turn();
		g.ready.resolve();
		await released;
		await turn();
		await turn();
		const before = c.frames;
		await c.say("nobody is reading");
		assert.deepEqual(
			{ detaches: c.detaches, unexpectedFrames: c.frames - before },
			{ detaches: 1, unexpectedFrames: 0 },
		);
	});

	it("a genuine end from the still-given harness fails the follower", async () => {
		await read();
		await c.closeGiven();
		await turn();
		await turn();
		assert.ok(t.errors.some((e) => e.kind === "object_failed" && e.object.startsWith("transcript.followed")));
	});

	it("an in-flight reader frame over a link folds a replacement and its later frames correctly", async () => {
		const ref = await read();
		const watch = await ref.view.watch(context);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let first = true;
		// The values a slow watcher over the link gets: Chord applies each call's ops onto the one before.
		let last: unknown = watch.value;
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			last = call.value;
			if (first) {
				first = false;
				entered.resolve();
				await gate.promise;
			}
		});
		await c.say("one");
		await entered.promise;
		await c.swap();
		await c.say("two");
		await c.swap();
		await c.say("three");
		gate.resolve();
		const all = ["one", "ok: one", "two", "ok: two", "three", "ok: three"];
		await until(ref.view, (v) => textsOf(v).length === all.length, within("the three answers", context));
		await eventually(
			() => textsOf(last),
			(seen) => seen.length === all.length,
		);
		assert.deepEqual([textsOf(last), textsOf(ref.view.value)], [all, all]);
		await watch.stop();
	});

	it("a late end from the old harness cannot end the new one; two orderly reloads recover", async () => {
		const ref = await read();
		c.holdEnd = true;
		await c.swap();
		await c.say("second");
		await until(ref.view, (v) => textsOf(v).includes("ok: second"), within("second", context));
		assert.ok(c.lateEnd);
		c.lateEnd();
		c.holdEnd = false;
		await c.swap();
		await c.say("third");
		await until(ref.view, (v) => textsOf(v).includes("ok: third"), within("third", context));
		assert.deepEqual(t.errors, []);
	});
});

type Observe = (
	id: unknown,
	observer: { advance(call: unknown, ctx: unknown): void; end(end: unknown): void },
	ctx: unknown,
) => Promise<{ value: unknown; detach(): void }>;

/** A stand-in harness whose Durable has only `observeConversation` (all the follower uses). */
const fake = (observeConversation: Observe) =>
	({ durable: { observeConversation }, submit: async () => {} }) as unknown as OpenHarness;

/** A view with a marker, to tell which one the transcript shows. */
const view = (marker: string) => ({ entries: [], marker });

const at =
	(marker: string): Observe =>
	async () => ({ value: view(marker), detach: () => {} });

describe("the follower across stand-in harnesses (Opus, round 1 of the follower)", () => {
	let control: { give?: (harness: OpenHarness | undefined) => void };
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		control = {};
		const harness = defineFacet((host) => {
			host.serve(SessionHarness, { compose: (table) => table[0]?.value });
			contribute(host, "test.harness", (self) => {
				const given = self.writable<OpenHarness | undefined>(fake(at("A")));
				self.contribute(SessionHarness, given as Writable<OpenHarness>);
				control.give = (next) => given.set(next);
			});
		});
		const stand = standIns(sessionRow(SESSION, "/tmp"), []);
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "worker", session: SESSION, stubs: [{ name: "test.harness", facet: harness }], server: stand.server },
			context,
		);
	});

	afterEach(() => t.close(context));

	const marker = (value: unknown) => (value as { marker?: string } | null)?.marker;

	describe("a harness given while its observation attaches", () => {
		it("shows the new harness's latest view when it changed while being attached", async () => {
			await t.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
					await until(transcript.view, (v) => marker(v) === "A", within("A", ctx));
					// B's snapshot is B1; a commit lands while it attaches: "calls may come before the attaching promise
					// resolves; their ops apply from Observation.value" (Durable's Observer).
					control.give!(
						fake(async (_id, observer, c) => {
							observer.advance(
								{ kind: "value", value: view("B2"), ops: [["r", view("B2")]], retired: false },
								c,
							);
							return { value: view("B1"), detach: () => {} };
						}),
					);
					await new Promise((resolve) => setTimeout(resolve, 200));
					assert.equal(marker(transcript.view.value), "B2", "B's state is B2");
				},
				context,
				{ principal: OWNER },
			);
		});

		it("follows a later harness after one whose attach failed", async () => {
			await t.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
					await until(transcript.view, (v) => marker(v) === "A", within("A", ctx));
					control.give!(
						fake(async () => {
							throw new Error("B: session closed");
						}),
					);
					await new Promise((resolve) => setTimeout(resolve, 100));
					control.give!(fake(at("C")));
					await new Promise((resolve) => setTimeout(resolve, 300));
					assert.equal(marker(transcript.view.value), "C");
				},
				context,
				{ principal: OWNER },
			);
		});
	});

	describe("the current harness's end", () => {
		it("fails the follow when the harness still given ends its observer", async () => {
			let end: ((e: unknown) => void) | undefined;
			control.give!(
				fake(async (_id, observer) => {
					end = (e) => observer.end(e);
					return { value: view("D"), detach: () => {} };
				}),
			);
			await t.root(
				async (ctx) => {
					const transcript = withGranted(await ctx.get(Transcript, { session: SESSION }), "view")!;
					await until(transcript.view, (v) => marker(v) === "D", within("D", ctx));
					end!({ kind: "failed", error: new Error("D failed") });
					await new Promise((resolve) => setTimeout(resolve, 200));
					// Opus S1: an end of the harness still given fails the follow (and its retry follows again).
					assert.ok(t.errors.some((error) => error.kind === "object_failed"));
				},
				context,
				{ principal: OWNER },
			);
		});
	});
});
