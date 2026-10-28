// Entry 8: one shared binding per host and key; a hold implies the state of its variant (units: shape, then
// snapshots); method-only references; origins of client holds; protocol version 4.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { HostImpl } from "../src/host.ts";
import {
	type Ctx,
	createHost,
	type Frame,
	type Host,
	hostFamily,
	hostNamed,
	isChordError,
	type Link,
	local,
	memoryLinkPair,
	method,
	PROTOCOL_VERSION,
	remote,
} from "../src/index.ts";
import { CountingLink, stateFrames } from "./fixtures/counting.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	assert.ok(check(), "condition not reached");
}

const NoteSchema = Type.Array(Type.String());
const Notes = remote("t.e8-notes", {
	version: 1,
	input: Type.Object({ list: Type.Optional(Type.String({ default: "main" })) }),
	host: hostNamed("server"),
	variants: {
		main: {
			state: { notes: NoteSchema, title: Type.String() },
			methods: { add: method(Type.String()), rename: method(Type.String()) },
		},
	},
});

function serveNotes(host: Host): void {
	host.serve(Notes, (_input, _principal, self) => {
		const notes = self.state("notes", NoteSchema, []);
		const title = self.state("title", Type.String(), "untitled");
		return {
			variant: "main",
			notes,
			title,
			add: (text: string, ctx: Ctx) => {
				notes.change(ctx, (draft) => {
					draft.push(text);
				});
			},
			rename: (text: string, ctx: Ctx) => {
				title.replace(ctx, text);
			},
		};
	});
}

/** A server serving `Notes`, and a browser whose end of the link counts what crosses it. */
function setup(
	options: { readonly window?: number; readonly linger?: { types?: Record<string, number>; cap?: number } } = {},
) {
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	serveNotes(server);
	const [down, up] = memoryLinkPair();
	server.accept(down, {
		principal: { user: "u" },
		...(options.window === undefined ? {} : { window: options.window }),
	});
	const link = new CountingLink(up);
	const errors: unknown[] = [];
	const browser = createHost({
		self: { kind: "host" },
		name: "browser",
		kind: "client",
		upstream: { link, principal: { kind: "server" } },
		onError: (error) => errors.push(error),
		...(options.linger === undefined ? {} : { linger: options.linger }),
	});
	return { server, browser, link, errors };
}

describe("shared bindings: traffic", () => {
	it("N references to one object: one hold, one snapshot per member, one frame per change, one release", async () => {
		const { server, browser, link } = setup();
		const Panel = local("t.e8-panel", { version: 1, input: Type.Object({}), members: { count: Type.Number() } });
		browser.serve(Panel, (_input, _principal, self) => {
			const notes = self.get(Notes, {});
			return { count: self.derive([notes.notes], (list) => list.length) };
		});
		const a = browser.hold(Notes, {});
		const b = browser.hold(Notes, { list: "main" });
		const panel = browser.hold(Panel, {});
		await Promise.all([a.ready, b.ready, panel.ready]);
		const viaCtx = await browser.root(async (ctx) => {
			const ref = await ctx.get(Notes, {});
			return ref.title.value;
		});
		assert.equal(viaCtx, "untitled");
		assert.equal(link.count("sent", "hold"), 1, "one hold for every reference");
		const snaps = stateFrames(link.received).filter((frame) => frame.as === "snap");
		assert.deepEqual(snaps.map((frame) => frame.m).sort(), ["notes", "title"]);

		const before = stateFrames(link.received).length;
		await a.add("milk");
		await until(() => a.notes.value.length === 1 && b.notes.value.length === 1 && panel.count.value === 1);
		await tick();
		assert.equal(stateFrames(link.received).length - before, 1, "one delta frame for one change, whatever N");

		const sent = link.traffic("sent").length;
		a.release();
		panel.release();
		await sleep(5);
		assert.equal(link.traffic("sent").length, sent, "releasing all but one reference sends nothing");
		b.release();
		await until(() => link.count("sent", "release") === 1);
		await browser.close();
		await server.close();
	});

	it("a held reference stays subscribed without listeners; values are readable at once after ready", async () => {
		const { server, browser } = setup();
		const notes = browser.hold(Notes, {});
		await notes.ready;
		assert.deepEqual(notes.notes.value, []);
		await notes.add("bread");
		await until(() => notes.notes.value.length === 1);
		assert.equal(notes.title.value, "untitled");
		await browser.close();
		await server.close();
	});
});

describe("shared bindings: linger", () => {
	it("a lingering binding keeps its hold and state; a reference taken meanwhile costs nothing on the link", async () => {
		const { server, browser, link } = setup({ linger: { types: { [Notes.name]: 40 } } });
		const first = await browser.get(Notes, {});
		const frames = link.traffic("received").length;
		first.release();
		await sleep(10);
		assert.equal(link.count("sent", "release"), 0, "not released before the linger");
		// A hook mounting and unmounting: no frames either way.
		for (let i = 0; i < 3; i++) {
			const again = await browser.get(Notes, {});
			assert.deepEqual(again.notes.value, []);
			again.release();
		}
		assert.equal(link.count("sent", "hold"), 1);
		assert.equal(link.traffic("received").length, frames, "nothing new crossed the link");
		await until(() => link.count("sent", "release") === 1);
		await browser.close();
		await server.close();
	});

	it("at most `cap` bindings linger: the least recently released goes first", async () => {
		const { server, browser, link } = setup({ linger: { types: { [Notes.name]: 10_000 }, cap: 1 } });
		const a = await browser.get(Notes, { list: "a" });
		const b = await browser.get(Notes, { list: "b" });
		a.release();
		await sleep(5);
		assert.equal(link.count("sent", "release"), 0);
		b.release();
		await until(() => link.count("sent", "release") === 1);
		const release = link.sent.find((frame) => frame.t === "release");
		const holdOfA = link.sent.find((frame) => frame.t === "hold" && (frame.input as { list: string }).list === "a");
		assert.equal(release?.t === "release" ? release.id : 0, holdOfA?.t === "hold" ? holdOfA.id : -1);
		await browser.close();
		await server.close();
	});
});

describe("shared bindings: identity", () => {
	it("normalized-equal inputs and equal principal keys share; other principals and fingerprints do not", async () => {
		const server = createHost({
			self: { kind: "host" },
			name: "server",
			onError: () => {},
		});
		const NotesV2 = remote("t.e8-notes", {
			version: 2,
			input: Type.Object({ list: Type.Optional(Type.String({ default: "main" })) }),
			host: hostNamed("server"),
			variants: {
				main: {
					state: { notes: NoteSchema, title: Type.String() },
					methods: { add: method(Type.String()), rename: method(Type.String()), clear: method() },
				},
			},
		});
		server.serve(
			NotesV2,
			(_input, _principal, self) => {
				const notes = self.state("notes", NoteSchema, []);
				const title = self.state("title", Type.String(), "untitled");
				return { variant: "main", notes, title, add: () => {}, rename: () => {}, clear: () => {} };
			},
			{ accepts: { 1: (current) => current } },
		);
		// A worker holds the server's objects; the principals it forwards key its bindings.
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:w" });
		const link = new CountingLink(up);
		const worker = createHost<unknown>({
			self: { kind: "host" },
			name: "session:w",
			upstream: { link, principal: { kind: "server" } },
			onError: () => {},
		});
		const refs = [
			worker.hold(Notes, {}),
			worker.hold(Notes, { list: "main" }),
			worker.hold(Notes, {}, { principal: { user: "a", grant: 1 } }),
			worker.hold(Notes, {}, { principal: { grant: 1, user: "a" } }),
			worker.hold(Notes, {}, { principal: { user: "a", grant: 2 } }),
			worker.hold(NotesV2, {}),
		];
		await Promise.all(refs.map((ref) => ref.ready));
		// host (shared by two inputs), user a grant 1 (shared by two key orders), user a grant 2, the v2 contract.
		assert.equal(link.count("sent", "hold"), 4);
		await worker.close();
		await server.close();
	});
});

describe("hydration over a link", () => {
	const Matrix = remote("t.e8-matrix", {
		version: 1,
		input: Type.Object({ variant: Type.String() }),
		host: hostNamed("server"),
		variants: {
			values: { state: { none: Type.Null(), empty: Type.Array(Type.String()), maybe: Type.Unknown() } },
			bare: { methods: { ping: method(undefined, Type.String()) } },
			broken: { state: { n: Type.Number() } },
		},
	});

	function serveMatrix(host: Host): void {
		host.serve(Matrix, ({ variant }, _principal, self) => {
			if (variant === "bare") return { variant: "bare", ping: () => "pong" };
			if (variant === "broken") {
				const source = self.state("source", Type.String(), "not a number");
				// A derivation exposed under a number schema: its snapshot fails validation.
				return { variant: "broken", n: self.derive([source], (text) => text as unknown as number) };
			}
			const none = self.state("none", Type.Null(), null);
			const empty = self.state("empty", Type.Array(Type.String()), []);
			return { variant: "values", none, empty, maybe: self.derive([none], () => undefined as unknown) };
		});
	}

	it("null, empty and undefined values hydrate; a state-free variant is ready; a failed snapshot rejects", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveMatrix(server);
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { user: "u" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const values = await browser.get(Matrix, { variant: "values" });
		assert.ok(values.variant === "values");
		assert.equal(values.none.value, null);
		assert.deepEqual(values.empty.value, []);
		assert.equal(values.maybe.value, undefined);
		const bare = await browser.get(Matrix, { variant: "bare" });
		assert.ok(bare.variant === "bare");
		assert.equal(await bare.ping(), "pong");
		assert.throws(
			// @ts-expect-error `none` is not a member of the bare variant (a narrowed reference does not show it).
			() => bare.none.value,
			(error) => isChordError(error, "not_in_variant"),
		);
		const broken = browser.hold(Matrix, { variant: "broken" });
		await assert.rejects(broken.ready, (error) => isChordError(error, "invalid"));
		assert.equal(broken.status, "gone");
		await browser.close();
		await server.close();
	});

	it("reading before the first hydration throws not_ready", async () => {
		const { server, browser } = setup();
		const notes = browser.hold(Notes, {});
		assert.throws(
			() => notes.notes.value,
			(error) => isChordError(error, "not_ready"),
		);
		await notes.ready;
		assert.deepEqual(notes.notes.value, []);
		await browser.close();
		await server.close();
	});
});

describe("method-only references (state: false)", () => {
	it("transfer no state alone; a full reference joining starts it once; its release stops it", async () => {
		const { server, browser, link } = setup();
		const caller = browser.hold(Notes, {}, { state: false });
		await caller.ready;
		await caller.add("x");
		const hold = link.sent.find((frame) => frame.t === "hold");
		assert.ok(hold?.t === "hold" && hold.state === false);
		assert.deepEqual(stateFrames(link.received), []);
		assert.throws(
			() => caller.notes.value,
			(error) => isChordError(error, "not_ready"),
		);

		const viewer = browser.hold(Notes, {});
		await viewer.ready;
		assert.deepEqual(viewer.notes.value, ["x"]);
		assert.equal(link.count("sent", "sub"), 1);
		assert.equal(link.count("sent", "hold"), 1, "the same hold");
		viewer.release();
		await until(() => link.count("sent", "unsub") === 1);
		const after = stateFrames(link.received).length;
		await caller.add("y");
		await sleep(5);
		assert.equal(stateFrames(link.received).length, after, "no state once only method-only references remain");
		await browser.close();
		await server.close();
	});
});

describe("origins of client holds", () => {
	const Counter = remote("t.e8-counter", {
		version: 1,
		input: Type.Object({ session: Type.String() }),
		host: hostFamily("session:", "session"),
		variants: { main: { state: { n: Type.Number() }, methods: { add: method(Type.Number()) } } },
	});

	function cluster() {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		let worker: HostImpl | undefined;
		let toWorker: CountingLink | undefined;
		server.route("session:", {
			principal: (name) => ({ host: name }),
			authorize: () => true,
			resolve: async (name) => {
				if (toWorker !== undefined) return toWorker;
				const [down, up] = memoryLinkPair();
				const created = new HostImpl({
					self: { kind: "host" },
					name,
					upstream: { link: up, principal: { kind: "server" } },
					onError: () => {},
				});
				created.serve(Counter, (_input, _principal, self) => {
					const n = self.state("n", Type.Number(), 0);
					return {
						variant: "main",
						n,
						add: (delta: number, ctx: Ctx) => {
							n.replace(ctx, n.value + delta);
						},
					};
				});
				worker = created;
				toWorker = new CountingLink(down);
				return toWorker;
			},
		});
		const browser = () => {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: { guest: "g" } });
			const host = createHost({
				self: { kind: "host" },
				name: "browser",
				kind: "client",
				upstream: { link: up, principal: { kind: "server" } },
				onError: () => {},
			});
			return { host, up };
		};
		const origins = () =>
			[...(worker?.upstream?.served.values() ?? [])].map((served) =>
				served.kind === "local" ? served.origin : undefined,
			);
		return { server, browser, origins, sentToWorker: () => toWorker?.sent ?? [] };
	}

	it("a relayed hold carries its client connection's id; the server's own holds carry none", async () => {
		const c = cluster();
		const one = c.browser();
		const two = c.browser();
		await one.host.hold(Counter, { session: "S1" }).ready;
		await two.host.hold(Counter, { session: "S1" }).ready;
		const own = c.server.hold(Counter, { session: "S1" });
		await own.ready;
		const holds = c.sentToWorker().filter((frame): frame is Extract<Frame, { t: "hold" }> => frame.t === "hold");
		assert.equal(holds.length, 3);
		const relayed = holds.filter((frame) => frame.origin !== undefined);
		assert.equal(relayed.length, 2);
		assert.notEqual(relayed[0]!.origin, relayed[1]!.origin, "two tabs, two origins");
		assert.equal(holds.filter((frame) => frame.origin === undefined).length, 1);

		// Disconnect is departure: the worker loses that origin at once; a reconnect holds under a new id.
		const before = new Set(c.origins());
		one.up.close();
		await until(() => c.origins().filter((origin) => origin !== undefined).length === 1);
		const three = c.browser();
		await three.host.hold(Counter, { session: "S1" }).ready;
		const after = c.origins().filter((origin) => origin !== undefined);
		assert.equal(after.length, 2);
		assert.ok(
			after.some((origin) => !before.has(origin)),
			"a new connection gets a new id",
		);
		await c.server.close();
	});

	it("an origin a client sends is ignored: the server stamps its own", async () => {
		const c = cluster();
		const [down, raw] = memoryLinkPair();
		c.server.accept(down, { principal: { guest: "g" } });
		raw.receive(() => {});
		raw.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "raw", kind: "client", codeVersion: 0 });
		raw.send({
			t: "hold",
			id: 1,
			at: "session:S1",
			token: Counter.description,
			input: { session: "S1" },
			origin: "spoofed",
		});
		await until(() => c.sentToWorker().some((frame) => frame.t === "hold"));
		const hold = c.sentToWorker().find((frame) => frame.t === "hold");
		assert.ok(hold?.t === "hold" && hold.origin !== undefined && hold.origin !== "spoofed");
		await c.server.close();
	});
});

describe("protocol version 4", () => {
	it("a version 3 peer is refused; shapes carry no code version", async () => {
		const { server, browser, link } = setup();
		await browser.hold(Notes, {}).ready;
		const shape = link.received.find((frame) => frame.t === "shape");
		assert.ok(shape !== undefined && !("codeVersion" in shape));
		assert.deepEqual(shape.t === "shape" ? [...shape.state].sort() : [], ["notes", "title"]);

		const [down, raw] = memoryLinkPair();
		server.accept(down, { principal: { user: "old" } });
		const closed = new Promise<string>((resolve) => (raw as Link).onClose(resolve));
		raw.receive(() => {});
		raw.send({ t: "hello", protocol: 3, name: "old", kind: "client", codeVersion: 0 });
		assert.equal(await closed, `protocol-version ${PROTOCOL_VERSION}`);
		assert.equal(PROTOCOL_VERSION, 4);
		await browser.close();
		await server.close();
	});
});
