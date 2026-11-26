// Tests of admission with a typed value (slice 14 §2; test lists 14 and 20): a remote type's `admit` runs before its
// factory and hands it a value; the attempt parks on a denial and on its sources; each row of the watch table (an
// equal value, a loading source, another value, a denial, a failed source) with calls running; what a denial removes
// and what stays with application code; dependents of a denied object; presence, linger, `parked_long` and
// `ref.retry()`; declaration errors and the refusal of jobs; over a link (`failed { denied }`, replicas dropped, a
// joining reference, revocation); and reloads: of an admission's source (equal, changed, denied, parked, removed, a
// contract bumped with and without `accepts`), of the admitted type itself (rehearsal by fingerprint, an unrehearsed
// factory's error at its activation, a decision change while its old attempt drains or its successor opens a native).

import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { awaitWithContext, type Context, BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import {
	evolve,
	grantable,
	int,
	local,
	map,
	method,
	obj,
	oneOf,
	queries,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { currentVersion } from "../../src/contracts/internal.ts";
import { broken, ChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { type Allowed, Decision } from "../../src/host/admission.ts";
import { ChordHost } from "../../src/host/host.ts";
import {
	type Admit,
	allow,
	createHost,
	defineFacet,
	deny,
	type Facet,
	type FacetHost,
	type HostError,
	type Self,
} from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";
import { Source } from "../../src/state/internal.ts";
import { query } from "../../src/store/index.ts";
import { defineTable } from "../../src/store/table.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	holdNextCommit,
	instancesOf,
	linked,
	memoryStore,
	metered,
	rejection,
	Server,
	settledHeap,
	statesOf,
	type TestPrincipal,
	valuesOf,
} from "../support.ts";

/** Every decision declared while this file runs, weakly. */
const decisions = instancesOf(Decision, "declare");

/** Every object that started an attempt while this file runs, weakly (`failLive`). */
const objects = instancesOf(ChordObject, "attempt");

/** The label of every object whose first (or retried) attempt started while this file runs: one per new object. */
const started: string[] = [];
const attempt = ChordObject.prototype.attempt;
ChordObject.prototype.attempt = function (this: ChordObject) {
	started.push(this.label);
	return attempt.call(this);
};

const Modes = defineState("modes", {
	schema: obj({ modes: map(str()) }),
	version: 1,
	initial: () => ({ modes: {} as Record<string, string> }),
});

/** Who may do what, by principal kind: the store the admissions read. `throw` makes its reader's derive throw. */
const Access = local("test.access", {
	version: 1,
	params: {},
	members: { modes: map(str()), set: method(obj({ who: str(), mode: str() })) },
});

/** `Access` with one more member: version 1's consumers bind it only through `accepts`. */
const AccessV2 = evolve(Access, (e) => e.addState("extra", str()));

/** A per-document source of the admission, with params: it ends with its last reference. */
const Share = local("test.share", { version: 1, params: { id: str() }, members: { open: str() } });

/** A type nobody serves. */
const Missing = local("test.missing", { version: 1, params: {}, members: { n: int() } });

const Mode = obj({ mode: oneOf("read", "write") });

/** The admitted type: everyone admitted reads its text; the admitted mode `write` grants `write`. */
const Doc = remote("test.doc", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	admission: Mode,
	state: { text: str() },
	methods: { write: grantable(method(str(), str())) },
});

/** How a document's reference was admitted: `writer` granted `write`, `reader` live without it, else `undefined`. */
function role(doc: {
	readonly granted: ReadonlySet<string>;
	readonly state: { readonly value: { readonly kind: string } };
}) {
	if (doc.granted.has("write")) return "writer";
	return doc.state.value.kind === "live" ? "reader" : undefined;
}

/** `Doc` with another admission schema (the same wire fingerprint): a reload does not rehearse across it. */
const DocV2 = evolve(Doc, (e) => e.admission(obj({ mode: oneOf("read", "write"), since: int() })));

/** A consumer of a document on the same host: a derive over its text. */
const Panel = local("test.panel", { version: 1, params: { id: str() }, members: { shout: str() } });

const Text = defineState("text", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "t" }) });

const Work = defineJob("test.work", { version: 1, args: obj({}), result: int() });

const Log = defineTable("log", { version: 1, columns: { line: str() }, key: ["line"] });

/** A persisted log on the host: `append` commits one row. */
const Journal = local("test.journal", {
	version: 1,
	params: {},
	members: { append: method(str()), has: method(str(), int()) },
});

/** What a served `Access` does besides keeping the modes. */
type AccessCode = {
	/** A native that opens once this resolves: a reload's successor stays `loading` meanwhile. */
	readonly opened?: Promise<void>;
	/** Declares a type nobody serves: the attempt parks `failed { waiting }`. */
	readonly needsMissing?: boolean;
	/** Its native's open fails `broken` while the flag says so. */
	readonly broken?: { on: boolean };
	/** The factory's `self`, for `failLive`. */
	readonly selves?: Self<TestPrincipal>[];
};

/** A facet serving `Access` (as `contract`). */
function accessFacet(code: AccessCode = {}, contract: typeof Access | typeof AccessV2 = Access, accepts?: object) {
	return defineFacet<TestPrincipal>((facet) => {
		const serve = facet.serve as (...args: unknown[]) => void;
		serve(
			contract,
			(
				_: unknown,
				self: Self<TestPrincipal> & { state: (definition: typeof Modes) => ReturnType<typeof stateOf> },
			) => {
				code.selves?.push(self);
				const state = self.state(Modes);
				if (code.opened !== undefined || code.broken !== undefined) {
					self.open(
						async () => {
							if (code.broken?.on) throw broken(new Error("access is broken"));
							await code.opened;
						},
						() => {},
					);
				}
				if (code.needsMissing) self.get(Missing, {});
				return {
					modes: self.derive([state], ([s]) => s.modes),
					...(contract === AccessV2 ? { extra: constant("x") } : {}),
					set: async ({ who, mode }: { who: string; mode: string }, ctx: Parameters<typeof state.change>[1]) => {
						await state.change((draft) => {
							draft.modes[who] = mode;
						}, ctx);
						return null;
					},
				};
			},
			accepts === undefined ? {} : { accepts },
		);
	});
}

/** The type of `self.state(Modes)`, for the untyped serve above. */
declare function stateOf(): {
	change(fn: (draft: { modes: Record<string, string> }) => void, ctx: unknown): Promise<void>;
};

/** What a mode means to the admission. */
function decide(mode: string | undefined) {
	if (mode === "throw") throw new Error("the rule threw");
	if (mode === "read") return allow({ mode });
	return mode === "write" ? allow({ mode, granted: ["write"] }) : deny("no access");
}

/** The admission of `Doc`: the caller's mode in `Access`; with `share`, its per-document source too. */
function admitBy(share = false): Admit<typeof Doc, TestPrincipal> {
	return ({ id }, principal, self) => {
		const modes = self.get(Access, {}).modes;
		if (!share) return self.derive([modes], ([all]) => decide(all[principal.kind]));
		const open = self.get(Share, { id }).open;
		return self.derive([modes, open], ([all]) => decide(all[principal.kind]));
	};
}

/** What a served `Doc` does. */
type DocCode = {
	/** Its factory's runs, `id:mode`. */
	readonly built: string[];
	/** What `write` waits for. */
	readonly gate?: Promise<void>;
	/** A native that opens once this resolves; its opens and closes are logged in `natives`. */
	readonly opened?: Promise<void>;
	readonly natives?: string[];
	/** What the native's close waits for. */
	readonly closing?: Promise<void>;
	readonly linger?: number;
	readonly admit?: Admit<typeof Doc, TestPrincipal>;
	/** A declaration only the factory makes (a job: refused; a throw). */
	readonly declare?: (self: Self<TestPrincipal>, mode: string) => void;
	/** What `write` does before it answers. */
	readonly write?: (text: string, self: Self<TestPrincipal>) => Promise<void>;
};

/** A facet serving `Doc` (as `contract`) and `Share`, `Panel` and `Journal`. */
function docFacet(
	code: DocCode,
	contract: typeof Doc | typeof DocV2 = Doc,
	shares: string[] = [],
): Facet<TestPrincipal> {
	return defineFacet<TestPrincipal>((facet) => {
		const serve = facet.serve as (...args: unknown[]) => void;
		serve(
			contract,
			(
				{ id }: { id: string },
				_principal: TestPrincipal,
				admitted: { mode: "read" | "write" },
				self: Self<TestPrincipal>,
			) => {
				code.built.push(`${id}:${admitted.mode}`);
				code.declare?.(self, admitted.mode);
				const text = self.state(Text);
				if (code.opened !== undefined) {
					self.open(
						async () => {
							await code.opened;
							code.natives?.push("open");
						},
						async () => {
							await code.closing;
							code.natives?.push("close");
						},
					);
				}
				const shown = self.derive([text], ([t]) => t.text);
				const write = async (next: string, ctx: Parameters<typeof text.change>[1]) => {
					// As a handler waits: its caller's cancellation and its attempt's seal end the wait.
					await awaitWithContext(code.gate ?? Promise.resolve(), ctx);
					await code.write?.(next, self);
					await text.change((draft) => {
						draft.text = next;
					}, ctx);
					return `${admitted.mode}:${next}`;
				};
				return { text: shown, write };
			},
			{ admit: code.admit ?? admitBy(), linger: code.linger },
		);
		facet.serve(Share, ({ id }) => {
			shares.push(id);
			return { open: constant("yes") };
		});
		facet.serve(Panel, ({ id }, self) => {
			const doc = self.get(Doc, { id });
			return { shout: self.derive([doc.text], ([text]) => text.toUpperCase()) };
		});
	});
}

/** A facet serving `Journal` on the host's store. */
const journalFacet = defineFacet<TestPrincipal>((facet) => {
	facet.serve(Journal, (_, self) => {
		const log = self.table(Log);
		return {
			append: async (line, ctx) => {
				await self.tx(async (tx) => tx.put(log, { line }), ctx);
				return null;
			},
			has: async (line, ctx) => ((await log.get({ line }, ctx)) === undefined ? 0 : 1),
		};
	});
});

/** A server with `Access` and `Doc` in two plugins, its errors, and `server`'s mode set to `mode`. */
async function served(code: DocCode, options: { mode?: string; access?: AccessCode; readyTimeout?: number } = {}) {
	const errors: HostError[] = [];
	const h = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		readyTimeout: options.readyTimeout,
		onError: (error) => errors.push(error),
	});
	const doc = docFacet(code);
	const plugins = { access: accessFacet(options.access), doc };
	const facets = () => [
		{ name: "@test/access", facet: plugins.access },
		{ name: "@test/doc", facet: plugins.doc },
	];
	await h.load(facets(), context);
	const access = await h.get(Access, {}, context);
	const set = (mode: string, who = "server") => access.set({ who, mode }, context);
	if (options.mode !== undefined) await set(options.mode);
	const reload = (next: Partial<typeof plugins>) => {
		Object.assign(plugins, next);
		return h.reload(facets(), context);
	};
	return { h, errors, set, reload };
}

/** `error`'s code, reason and message. */
function told(error: unknown) {
	const { code, reason, message } = error as ChordError;
	return reason === undefined ? { code, message } : { code, reason, message };
}

/** The reported activation failures and long parks, by kind and message. */
function reports(errors: readonly HostError[]): string[] {
	return errors.map((error) =>
		error.kind === "activation_failed" ? `${error.kind}: ${error.failure.error.message}` : error.kind,
	);
}

/** Denies with the message of key `<key>` for a mode `deny:<key>`, an invalid one for `bad`, else as `decide`. */
const messageAdmit: Admit<typeof Doc, TestPrincipal> = (_params, principal, self) =>
	self.derive([self.get(Access, {}).modes], ([all]) => {
		const mode = all[principal.kind];
		if (mode === "bad") return deny("no access", { namespace: "docs", key: 7 } as never);
		if (mode?.startsWith("deny:")) {
			return deny("no access", { namespace: "docs", key: mode.slice(5), params: [principal.kind] });
		}
		return decide(mode);
	});

/** The message a reference's failure carries for the person, if any (`details.message`, slice 15 §2). */
function messageOf(doc: { readonly state: { readonly value: unknown } }): unknown {
	const state = doc.state.value as { cause?: { error: ChordError } };
	return (state.cause?.error.details as { message?: unknown } | undefined)?.message;
}

describe("a denial's message (slice 15 §2)", () => {
	const admit = messageAdmit;

	it("reaches the holder with the reason; without one there are no details", async () => {
		const built: string[] = [];
		const { h, set } = await served({ built, admit }, { mode: "deny:noShare" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await vi.waitFor(() => expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } }));
		expect(told((doc.state.value as { cause: { error: unknown } }).cause.error)).toEqual({
			code: "forbidden",
			message: "no access",
		});
		expect(messageOf(doc)).toEqual({ namespace: "docs", key: "noShare", params: ["server"] });
		await set("none");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(messageOf(doc)).toBe(undefined);
		expect(built).toEqual([]);
		await h.close(context);
	});

	it("goes with a call refused by the denial and with one running at the seal", async () => {
		const gate = Promise.withResolvers<void>();
		const { h, set } = await served({ built: [], admit, gate: gate.promise }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const running = rejection(doc.write!("x", context));
		await set("deny:revoked");
		const revokedCall = (await running) as ChordError;
		expect([revokedCall.code, revokedCall.reason]).toEqual(["forbidden", "revoked"]);
		expect((revokedCall.details as { message: unknown }).message).toEqual({
			namespace: "docs",
			key: "revoked",
			params: ["server"],
		});
		const refused = (await rejection(doc.text.watch(context).then(() => doc.text.value))) as ChordError;
		expect(refused.code).toBe("forbidden");
		expect((refused.details as { message: unknown }).message).toMatchObject({ key: "revoked" });
		gate.resolve();
		await h.close(context);
	});

	it("is part of the decision: another message is a new failure, without a rebuild or a new hold", async () => {
		const built: string[] = [];
		const { h, set } = await served({ built, admit }, { mode: "deny:first" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await vi.waitFor(() => expect(messageOf(doc)).toMatchObject({ key: "first" }));
		const started = decisions.length;
		await set("deny:second");
		await vi.waitFor(() => expect(messageOf(doc)).toMatchObject({ key: "second" }));
		expect([built, decisions.length - started]).toEqual([[], 0]);
		await h.close(context);
	});

	it("is told apart from a reason that ends like its JSON (review round 2, Sol 3)", async () => {
		const message = { namespace: "docs", key: "noShare", params: ["server"] };
		// The message's canonical JSON, as a key that joins reason and message would end.
		const reason = 'no access {"key":"noShare","namespace":"docs","params":["server"]}';
		const admit: Admit<typeof Doc, TestPrincipal> = (_params, principal, self) =>
			self.derive([self.get(Access, {}).modes], ([all]) =>
				all[principal.kind] === "plain" ? deny(reason) : deny("no access", message),
			);
		const { h, set } = await served({ built: [], admit }, { mode: "plain" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await vi.waitFor(() => expect(doc.state.value).toMatchObject({ cause: { error: { message: reason } } }));
		await set("message");
		await vi.waitFor(() => expect(messageOf(doc)).toEqual(message));
		await h.close(context);
	});

	it("that is no message as data breaks the attempt, reported once", async () => {
		const { h, errors } = await served({ built: [], admit }, { mode: "bad" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await vi.waitFor(() => expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } }));
		expect(reports(errors)).toEqual([
			"activation_failed: test.doc(a): its denial's message is no message as data (MessageSchema): no access",
		]);
		await h.close(context);
	});
});

describe("an empty grant (review round 1, Astra 6)", () => {
	it("allow without granted and with an empty list are one decision: switching between them rebuilds nothing", async () => {
		const built: string[] = [];
		const admit: Admit<typeof Doc, TestPrincipal> = (_params, principal, self) =>
			self.derive([self.get(Access, {}).modes], ([all]) =>
				all[principal.kind] === "listed" ? allow({ mode: "read", granted: [] }) : allow({ mode: "read" }),
			);
		const { h, set } = await served({ built, admit }, { mode: "unlisted" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const started = decisions.length;
		await set("listed");
		await set("unlisted");
		await delivered();
		expect([built, decisions.length - started, doc.state.value.kind]).toEqual([["a:read"], 0, "live"]);
		await h.close(context);
	});
});

describe("an equal decision of another object (hot-path pass, 2026-11-26)", () => {
	const Picked = remote("eq.thing", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		state: { name: str() },
		methods: { add: grantable(method(str(), str())) },
		flags: { export: "Export" },
	});
	const Picks = defineState("picks", { schema: obj({ pick: str() }), version: 1, initial: () => ({ pick: "first" }) });
	const Pick = local("eq.pick", { version: 1, params: {}, members: { pick: str(), set: method(str()) } });
	const message = { namespace: "docs", key: "noShare", params: [1, "a"] };
	/** Each read makes its decision afresh: equal ones are other objects. */
	const cases: Record<string, () => unknown> = {
		first: () => allow({ level: 1, tags: ["x"], n: 0, granted: ["add", "export"] }),
		reordered: () => allow({ granted: ["export", "add", "add"], n: -0, tags: ["x"], level: 1 }),
		data: () => allow({ level: 2, tags: ["x"], n: 0, granted: ["add", "export"] }),
		fewer: () => allow({ n: 0, tags: ["x"], level: 2, granted: ["add", "add"] }),
		unknown: () => allow({ n: 0, tags: ["x"], level: 2, granted: ["add", "nope"] }),
		denied: () => deny("no", message),
		deniedAgain: () => deny("no", { params: [1, "a"], key: "noShare", namespace: "docs" }),
		otherMessage: () => deny("no", { ...message, params: [2, "a"] }),
	};

	async function picked() {
		const errors: HostError[] = [];
		const built: unknown[] = [];
		const h = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			onError: (error) => errors.push(error),
		});
		const facet = defineFacet<TestPrincipal>((host) => {
			host.serve(Pick, (_, self) => {
				const state = self.state(Picks);
				return {
					pick: self.derive([state], ([s]) => s.pick),
					set: async (pick, ctx) => {
						await state.change((draft) => {
							draft.pick = pick;
						}, ctx);
						return null;
					},
				};
			});
			host.serve(
				Picked,
				(_params, _principal, admitted) => {
					built.push(admitted);
					return { name: constant("n"), add: async (text: string) => text };
				},
				{ admit: (_p, _principal, self) => self.derive([self.get(Pick, {}).pick], ([p]) => cases[p]!() as never) },
			);
		});
		await h.load([{ name: "@test/picked", facet }], context);
		const pick = await h.get(Pick, {}, context);
		const set = async (name: string) => {
			await pick.set(name, context);
			await delivered();
		};
		return { h, set, built, errors };
	}

	it("names in another order, repeated, and -0 for 0 are the same decision: no rebuild, the same granted set", async () => {
		const { h, set, built } = await picked();
		const thing = await h.get(Picked, {}, context);
		const granted = thing.granted;
		expect([...granted]).toEqual(["add", "export"]);
		await set("reordered");
		expect([built.length, thing.granted, thing.state.value.kind]).toEqual([1, granted, "live"]);
		expect(thing.granted).toBe(granted);
		// The factory's value is the first one's: an equal decision is that decision.
		expect(built[0]).toMatchObject({ level: 1, tags: ["x"], n: 0 });
		await set("data");
		await vi.waitFor(() => expect(built).toHaveLength(2));
		expect(built[1]).toMatchObject({ level: 2 });
		await set("fewer");
		await vi.waitFor(() => expect([...thing.granted]).toEqual(["add"]));
		expect(built).toHaveLength(3);
		await h.close(context);
	});

	it("a name that is no grant breaks even when the data and the other names are the last decision's", async () => {
		const { h, set, errors } = await picked();
		await set("fewer");
		const thing = await h.get(Picked, {}, context);
		await set("unknown");
		await vi.waitFor(() => expect(thing.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } }));
		expect(reports(errors)).toEqual([
			'activation_failed: eq.thing: its admission granted "nope": no grantable member or flag of its contract',
		]);
		await h.close(context);
	});

	it("an equal denial of another object is the same failure; another message is a new one", async () => {
		const { h, set } = await picked();
		await set("denied");
		const thing = h.hold(Picked, {}, context);
		await vi.waitFor(() => expect(thing.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } }));
		const shown = thing.state.value;
		await set("deniedAgain");
		expect(thing.state.value).toBe(shown);
		await set("otherMessage");
		await vi.waitFor(() => expect(thing.state.value).not.toBe(shown));
		expect(thing.state.value).toMatchObject({ cause: { error: { details: { message: { params: [2, "a"] } } } } });
		await h.close(context);
	});
});

/** A decision over a source whose value the test sets one read at a time. */
function reading() {
	const host = new ChordHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		onError: () => {},
	});
	const source = new (class extends Source {
		next: unknown;
		get value(): never {
			return this.next as never;
		}
		deliver() {}
	})(host.batch);
	const caller = { principal: host.principal, incarnation: host.incarnation };
	const decision = new Decision({
		host,
		label: "doc",
		dependent: undefined,
		caller,
		grants: ["a", "b"],
		moved() {},
	});
	decision.declare(() => source, context);
	return { decision, source };
}

// Found by the review of the hot-path pass (Astra, 2026-11-26): a direct comparison only for plain JSON; anything else
// as before (its text made at read time), with the same order of checks, counts and errors.
describe("a re-read of a value that is no plain JSON", () => {
	it("a released decision still reachable keeps no list its source dropped", async () => {
		const { decision, source } = reading();
		const ref = (() => {
			const raw = Array(40).fill("a");
			source.next = { kind: "allow", value: { granted: raw } };
			decision.now(context);
			return new WeakRef(raw);
		})();
		decision.release();
		source.next = null;
		await expectCollected(ref);
		expect(decision.dependencies).toHaveLength(0);
	});

	it("equal values nested 5,000 deep, built apart, are one decision", () => {
		const deep = (depth: number) => {
			let x: unknown = 0;
			for (let level = 0; level < depth; level++) x = { x };
			return { kind: "allow", value: { x } };
		};
		for (let depth = 250; depth <= 5000; depth += 250) {
			const { decision, source } = reading();
			source.next = deep(depth);
			const first = decision.now(context);
			source.next = deep(depth);
			expect(decision.now(context) === first).toBe(true);
		}
	});
});

// The reviews of the hot-path pass (Astra, 2026-11-26): what a decision compares a read with, and what it keeps.
describe("what a decision compares a read with", () => {
	function read(decision: ReturnType<typeof reading>, wrapped: unknown) {
		decision.source.next = wrapped;
		return decision.decision.now(context);
	}
	const allowing = (value: unknown) => ({ kind: "allow", value });

	it("the first list and object are collected after an equal read of others while the decision stays", async () => {
		const s = reading();
		const refs = (() => {
			const list = Array(64).fill("a");
			const raw = { granted: list };
			read(s, allowing(raw));
			return [new WeakRef(list), new WeakRef(raw)];
		})();
		read(s, allowing({ granted: ["a"] }));
		await expectCollected(...refs);
		expect(s.decision.now(context).kind).toBe("allow");
	});

	it("equal plain values of other objects: -0, a __proto__ key, null prototypes, frozen data, deep and long", () => {
		const deep = (depth: number) => {
			let value: unknown = 1;
			for (let level = 0; level < depth; level++) value = { value };
			return value;
		};
		const pairs: unknown[][] = [
			[{ v: -0 }, { v: 0 }],
			[JSON.parse('{"__proto__":1}'), Object.assign(Object.create(null), JSON.parse('{"__proto__":1}'))],
			[Object.seal({ x: 2 }), Object.freeze({ x: 2 })],
			...[14, 15, 16, 17].map((depth) => [deep(depth), deep(depth)]),
			...[253, 254, 255, 256, 257].map((length) => [{ v: Array(length).fill("a") }, { v: Array(length).fill("a") }]),
		];
		for (const pair of pairs) {
			const s = reading();
			const first = read(s, allowing(pair[0]));
			for (const value of pair.slice(1)) expect(read(s, allowing(value))).toBe(first);
		}
	});
});

// The third review of the hot-path pass (Astra, 2026-11-26): 30 to 33 names; 31 names compare as fast as 30; a changed
// read walks the listed names, not every grant of the contract.
describe("the order of a read", () => {
	/** A decision granting `grants`, read with an allow of `value` under `under`. */
	function reader(grants: readonly string[]) {
		const host = new ChordHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			onError: () => {},
		});
		const source = new (class extends Source {
			next: unknown;
			get value(): never {
				return this.next as never;
			}
			deliver() {}
		})(host.batch);
		const caller = { principal: host.principal, incarnation: host.incarnation };
		const decision = new Decision({ host, label: "doc", dependent: undefined, caller, grants, moved() {} });
		decision.declare(() => source, context);
		return (value: unknown, under: Context = context) => {
			source.next = { kind: "allow", value };
			return decision.now(under) as Allowed;
		};
	}

	it("equal reads stay one verdict and changes rebuild, from 30 to 33 names", () => {
		for (const n of [30, 31, 32, 33]) {
			const names = Array.from({ length: n }, (_, index) => `f${String(index).padStart(3, "0")}`);
			const read = reader(names);
			const raw = { granted: names.slice(), v: { a: [{ b: 1 }] } };
			const first = read(raw);
			expect([...first.granted]).toEqual(names);
			expect(read({ ...raw, granted: [...names].reverse().concat(names[0]!) })).toBe(first);
			const minus = names.slice(1).concat(names[1]!);
			const next = read({ ...raw, granted: minus });
			expect(next).not.toBe(first);
			expect([...next.granted]).toEqual(names.slice(1));
			expect(read({ ...raw, granted: [...minus].reverse() })).toBe(next);
			const changed = read({ ...raw, granted: minus, v: { c: [1] } });
			expect(read({ ...raw, granted: minus, v: { c: [1] } })).toBe(changed);
		}
	});

	it("the admitted value has the rest copy's own keys in their order and its prototype", () => {
		const read = reader(["a"]);
		const value = Object.assign(
			Object.create(null),
			JSON.parse('{"v":"data","__proto__":{},"granted":["a"],"3":"i","tail":1}'),
		);
		const admitted = read(value).value as object;
		expect(Reflect.ownKeys(admitted)).toEqual(["3", "v", "__proto__", "tail", "granted"]);
		expect([Object.getPrototypeOf(admitted), Object.hasOwn(admitted, "__proto__")]).toEqual([Object.prototype, true]);
	});

	/** A decision over a contract of `n` flags granting the first `listed`, read `runs` times: its time. */
	function flags(n: number, listed: number, change: boolean) {
		const codes = Array.from({ length: n }, (_, index) => `f${String(index).padStart(4, "0")}`);
		const Flagged = remote(`app.flags${n}`, {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: {},
			flags: Object.fromEntries(codes.map((flag) => [flag, flag])),
		});
		const read = reader(currentVersion(Flagged).grants);
		const granted = codes.slice(0, listed);
		const values = [0, 1].map((role) => ({ granted, role: change ? role : 0 }));
		return (runs: number): number => {
			let sum = 0;
			const start = performance.now();
			for (let run = 0; run < runs; run++) sum += (read(values[run % 2]).value as { role: number }).role;
			const duration = performance.now() - start;
			expect(sum).toBe(change ? runs / 2 : 0);
			return duration;
		};
	}

	const median = (list: number[]) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)]!;

	it("a changed role granting the first of 4,096 flags walks the listed names, not every flag", () => {
		const [small, big] = [flags(1, 1, true), flags(4096, 1, true)];
		small(2000);
		big(2000);
		const ratios = Array.from({ length: 7 }, () => big(6000) / small(6000));
		expect(median(ratios)).toBeLessThan(4);
	});

	it("31 kept names of 2,048 flags compare as fast as 30", () => {
		const [thirty, thirtyOne] = [flags(2048, 30, false), flags(2048, 31, false)];
		thirty(100);
		thirtyOne(100);
		const ratios = Array.from({ length: 7 }, () => thirtyOne(400) / thirty(400));
		expect(median(ratios)).toBeLessThan(3);
	});
});

describe("a decision's settle (hot-path pass: no async frames where nothing waits)", () => {
	it("answers in the turns it took as an async function throughout, without keys to load or live queries", async () => {
		const { decision, source } = reading();
		source.next = { kind: "allow", value: { granted: ["a"] } };
		let turns = 0;
		let answered = -1;
		void decision.settle({ blockedBy: () => {} }, context).then(() => {
			answered = turns;
		});
		for (let turn = 0; turn < 8; turn++) {
			await null;
			turns++;
		}
		// Measured on 1cbc0e094 (settle, pinKeys and openReaders all async functions).
		expect(answered).toBe(2);
	});
});

describe("deny, then allow", () => {
	it("a direct hold shows failed { denied } with the reason, then binds with what the value grants", async () => {
		const built: string[] = [];
		const { h, errors, set } = await served({ built });
		const doc = h.hold(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		await delivered();
		expect(doc.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no access" } },
			retryAt: undefined,
		});
		// The factory has not run: nothing is built for a caller who is denied.
		expect(built).toEqual([]);
		await set("read");
		await delivered();
		expect([doc.state.value.kind, role(doc), doc.text.value]).toEqual(["live", "reader", "t"]);
		expect(built).toEqual(["a:read"]);
		expect(states).toEqual(["failed: no access", "loading", "live"]);
		expect(errors).toEqual([]);
		await h.close(context);
	});

	it("a getter rejects at once with the denial, and resolves once allowed", async () => {
		const { h, set } = await served({ built: [] });
		expect(told(await rejection(h.get(Doc, { id: "a" }, context)))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		await set("write");
		const doc = await h.get(Doc, { id: "a" }, context);
		expect(role(doc)).toBe("writer");
		await h.close(context);
	});

	it("a dependent's self.get shows the denial, stays parked and heals when access returns", async () => {
		const { h, errors, set } = await served({ built: [] });
		const panel = h.hold(Panel, { id: "a" }, context);
		await delivered();
		// Denied, not broken: the dependency's `forbidden` is no authority refusal that never heals.
		expect(panel.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no access" } },
		});
		await set("read");
		await delivered();
		expect([panel.state.value.kind, panel.shout.value]).toEqual(["live", "T"]);
		expect(errors).toEqual([]);
		await h.close(context);
	});
});

describe("the watch table (2.2)", () => {
	it("an equal value changes nothing: no rebuild, the running call completes", async () => {
		const built: string[] = [];
		const gate = Promise.withResolvers<void>();
		const { h, set } = await served({ built, gate: gate.promise }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		const writing = doc.write ? doc.write("x", context) : undefined;
		// Another person's mode changes the source's value, not this caller's decision.
		await set("read", "guest");
		await set("write");
		await delivered();
		gate.resolve();
		expect(await writing).toBe("write:x");
		expect(built).toEqual(["a:write"]);
		expect(states).toEqual([]);
		await h.close(context);
	});

	it("another allowed value seals the attempt: its calls reject unavailable, its holders see loading, then the new grant", async () => {
		const built: string[] = [];
		const { h, errors, set } = await served({ built, gate: new Promise<void>(() => {}) }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		const frames = changesOf(await doc.text.watch(context));
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await set("read");
		// In the flush of the change: sealed, and loading with the last value readable.
		expect(doc.state.value.kind).toBe("loading");
		expect(doc.text.value).toBe("t");
		expect(told(await writing)).toEqual({ code: "unavailable", message: "test.doc(a): its admission changed" });
		await delivered();
		expect([doc.state.value.kind, role(doc)]).toEqual(["live", "reader"]);
		expect(built).toEqual(["a:write", "a:read"]);
		expect(states).toEqual(["loading", "live"]);
		// The same text on the new instance: no frame.
		expect(valuesOf(frames)).toEqual([]);
		expect(errors).toEqual([]);
		await h.close(context);
	});

	it("a denial seals the attempt: its calls reject forbidden/revoked, its holders see failed { denied } at once", async () => {
		const built: string[] = [];
		const { h, set } = await served({ built, gate: new Promise<void>(() => {}) }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await set("none");
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(told(await writing)).toEqual({
			code: "forbidden",
			reason: "revoked",
			message: "test.doc(a): no access",
		});
		await delivered();
		// No `loading` in between: the denial is shown in the flush that made it.
		expect(states).toEqual(["failed: no access"]);
		expect(built).toEqual(["a:write"]);
		await h.close(context);
	});

	it("a decision that throws when read is a failed source: sealed, calls unavailable, holders failed { waiting }", async () => {
		const built: string[] = [];
		const { h, set } = await served({ built, gate: new Promise<void>(() => {}) }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await set("throw");
		expect(((await writing) as ChordError).code).toBe("unavailable");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((doc.state.value as { cause: { error: Error } }).cause.error.message).toContain("the rule threw");
		// Not denied: the last value stays readable while it waits.
		expect(doc.text.value).toBe("t");
		await set("write");
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:write", "a:write"]);
		await h.close(context);
	});

	it("a source that fails live seals its readers, which park on it and rebuild when it is back", async () => {
		const built: string[] = [];
		const selves: Self<TestPrincipal>[] = [];
		const { h, set } = await served({ built }, { mode: "read", access: { selves } });
		const doc = await h.get(Doc, { id: "a" }, context);
		failLive(objects, selves[0]!, new ChordError({ code: "unavailable", message: "the store broke" }));
		expect(doc.state.value).toMatchObject({ kind: "loading" });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((doc.state.value as { cause: { error: Error } }).cause.error.message).toBe(
			"waiting for test.access: the store broke",
		);
		// The failed store is retried by its own getter; its modes are its object's documents.
		const access = h.hold(Access, {}, context);
		access.retry();
		await delivered();
		await set("read");
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read", "a:read"]);
		access.release();
		await h.close(context);
	});

	it("a call that crossed a seal runs on the next attempt under its value", async () => {
		const { h, set } = await served({ built: [] }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const writer = { write: doc.write! };
		await set("read");
		// Made while the new attempt admits (the reference is loading): it waits at the gate, never `not_ready`, and
		// meets the reader the new value selects, not the writer it was sent to.
		expect(told(await rejection(writer.write("y", context)))).toEqual({
			code: "forbidden",
			message: 'test.doc(a) has not granted "write"',
		});
		await set("write");
		expect(await writer.write("z", context)).toBe("write:z");
		await h.close(context);
	});
});

describe("what a denial removes", () => {
	it("references hold no value, a watch gets one failed call and keeps what it delivered, a derive over a member fails until the next allow", async () => {
		const { h, set } = await served({ built: [] }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const panel = await h.get(Panel, { id: "a" }, context);
		const watch = await doc.text.watch(context);
		const frames = changesOf(watch);
		const shouts = changesOf(await panel.shout.watch(context));
		await set("none");
		await delivered();
		expect(told(await rejection((async () => doc.text.value)()))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		expect(role(doc)).toBe(undefined);
		expect(valuesOf(frames)).toEqual([{ failed: "no access" }]);
		// Data already delivered to application code is not retracted.
		expect(watch.value).toBe("t");
		// The dependent stays live (R18); its derive over the member fails as a member.
		expect(panel.state.value.kind).toBe("live");
		expect(valuesOf(shouts)).toEqual([{ failed: "no access" }]);
		expect(told(await rejection((async () => panel.shout.value)()))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		await set("read");
		await delivered();
		expect(valuesOf(frames)).toEqual([{ failed: "no access" }, "t"]);
		expect(valuesOf(shouts)).toEqual([{ failed: "no access" }, "T"]);
		await h.close(context);
	});

	it("shows the denial before the sealed attempt's teardown finished", async () => {
		const natives: string[] = [];
		const closing = Promise.withResolvers<void>();
		const code = { built: [], opened: Promise.resolve(), natives, closing: closing.promise };
		const { h, set } = await served(code, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		await set("none");
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		await delivered();
		expect(natives).toEqual(["open"]);
		// Allowed again while the old native still closes: the factory waits for that teardown, the admission did not.
		await set("read");
		await delivered();
		expect(doc.state.value.kind).toBe("loading");
		closing.resolve();
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(natives).toEqual(["open", "close", "open"]);
		await h.close(context);
	});
});

describe("a failed admitted object", () => {
	it("that failed live follows a denial: failed { denied }, no value, out of presence, its factory not run again", async () => {
		const built: string[] = [];
		const selves: Self<TestPrincipal>[] = [];
		const { h, errors, set } = await served({ built, declare: (self) => void selves.push(self) }, { mode: "read" });
		const present = h.references(Doc);
		const doc = await h.get(Doc, { id: "a" }, context);
		failLive(objects, selves[0]!, new ChordError({ code: "unavailable", message: "broke live" }));
		await delivered();
		// Failed: its last value stays readable, its holder listed.
		expect([doc.state.value.kind, doc.text.value, present.value.length]).toEqual(["failed", "t", 1]);
		const made = decisions.length;
		await set("none");
		// In the denial's flush, with no new attempt.
		expect(doc.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no access" } },
			retryAt: undefined,
		});
		expect(() => doc.text.value).toThrow("no access");
		expect([role(doc), present.value]).toEqual([undefined, []]);
		await delivered();
		expect([built, decisions.length - made]).toEqual([["a:read"], 0]);
		// Allowed again: another decision than the denial, so the object is retried.
		await set("read");
		await delivered();
		expect([doc.state.value.kind, doc.text.value, built]).toEqual(["live", "t", ["a:read", "a:read"]]);
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed"]);
		await h.close(context);
	});

	it("whose factory broke for one value is retried by another allowed value, and by nothing else", async () => {
		const built: string[] = [];
		const declare = (_self: Self<TestPrincipal>, mode: string) => {
			if (mode === "write") throw new Error("the writer is broken");
		};
		const { h, set } = await served({ built, declare }, { mode: "write" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		// An equal decision and a failed source change nothing: the broken factory is not run again.
		await set("read", "guest");
		await set("throw");
		await delivered();
		expect([doc.state.value, built]).toMatchObject([{ kind: "failed", cause: { kind: "broken" } }, ["a:write"]]);
		await set("read");
		await delivered();
		expect([doc.state.value.kind, role(doc), built]).toEqual(["live", "reader", ["a:write", "a:read"]]);
		doc.release();
		await h.close(context);
	});

	// Found by the review of the hold-memory pass (2026-11-25): a decision follows its references' states until its
	// attempt's context is aborted, not for its own life.
	it("whose factory broke is not retried by a reference of its admission that went down and came back", async () => {
		const built: string[] = [];
		const admit: Admit<typeof Doc, TestPrincipal> = (_params, _principal, self) => {
			self.get(Access, {});
			return constant(allow({ mode: "read" }));
		};
		const declare = () => {
			if (built.length === 1) throw new Error("the factory is broken");
		};
		const { h, reload } = await served({ built, admit, declare });
		const doc = h.hold(Doc, { id: "a" }, context);
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		// Its admission's reference parks on a type nobody serves, then is live again: the decision is the same allow.
		await reload({ access: accessFacet({ needsMissing: true }) });
		await delivered();
		await reload({ access: accessFacet() });
		await delivered();
		expect([doc.state.value, built]).toMatchObject([{ kind: "failed", cause: { kind: "broken" } }, ["a:read"]]);
		doc.release();
		await h.close(context);
	});

	// Found by the same review: the follows end ahead of the listeners of signals made from the attempt's context
	// later (an opener's). Ended after them, the admission below ran twice and the object showed `failed { waiting }`.
	it("whose opener timed out is not admitted again by a reference that fails in the opener's abort listener", async () => {
		const Health = local("test.health", { version: 1, params: {}, members: { status: str() } });
		const Item = remote("test.item", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: { name: str() },
			admission: obj({}),
		});
		let fail = (): void => {
			throw new Error("the monitor is not followed yet");
		};
		const stopped = Promise.withResolvers<void>();
		let admitted = 0;
		const facet = defineFacet<TestPrincipal>((host) => {
			host.serve(Health, (_, self) => ({
				status: self.follow(async (observer) => {
					fail = () => observer.end({ kind: "failed", error: new Error("the monitor stopped") });
					return { value: "ok", detach() {} };
				}),
			}));
			host.serve(
				Item,
				(_params, _principal, _admitted, self) => {
					// An opener that never opens; cancelled (the ready timeout), it stops the monitor in its abort listener.
					self.open(
						(opening) => {
							const { context: waiting } = withCancel(opening);
							return new Promise<never>((_resolve, reject) => {
								waiting.abortSignal!.addEventListener("abort", () => {
									fail();
									stopped.resolve();
									reject(waiting.abortSignal!.reason);
								});
							});
						},
						() => {},
					);
					return { name: constant("item") };
				},
				{
					admit: (_params, _principal, self) => {
						admitted++;
						self.get(Health, {});
						return constant(allow({}));
					},
				},
			);
		});
		const options = {
			address: Server(),
			principal: { kind: "server" },
			readyTimeout: 50,
			onError: () => {},
		} as const;
		const h = createHost<TestPrincipal>(options);
		await h.load([{ name: "@test/health", facet }], context);
		const item = h.hold(Item, {}, context);
		await stopped.promise;
		await delivered();
		expect([admitted, item.state.value]).toMatchObject([1, { kind: "failed", cause: { kind: "transient" } }]);
		item.release();
		await h.close(context);
	});

	// Found by the same review, on a decision of its own (no owner of today cancels in its first telling): a context
	// aborted by a reference's first telling ends that reference's follow too, and follows no later one.
	it("a decision whose first telling aborts its context is told of no reference after it", async () => {
		const Health = local("test.health", { version: 1, params: {}, members: { status: str() } });
		let fail = (): void => {
			throw new Error("the monitor is not followed yet");
		};
		const facet = defineFacet<TestPrincipal>((host) =>
			host.serve(Health, (_, self) => ({
				status: self.follow(async (observer) => {
					fail = () => observer.end({ kind: "failed", error: new Error("the monitor stopped") });
					return { value: "ok", detach() {} };
				}),
			})),
		);
		const h = new ChordHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await h.load([{ name: "@test/health", facet }], context);
		const held = await h.get(Health, {}, context);
		const stopping = withCancel(context);
		let told = 0;
		const decision = new Decision({
			host: h,
			label: "a decision",
			caller: { principal: h.principal, incarnation: h.incarnation },
			dependent: undefined,
			grants: undefined,
			moved: () => {
				if (++told === 1) stopping.cancel();
			},
		});
		decision.declare((self) => {
			self.get(Health, {});
			self.get(Health, {});
			return constant(allow(null));
		}, stopping.context);
		expect(told).toBe(1);
		fail();
		expect(told).toBe(1);
		decision.release();
		held.release();
		await h.close(context);
	});
});

describe("an admission's requests", () => {
	it("are kept across a rebuild until the successor's bound: a source held only by them never ends", async () => {
		const shares: string[] = [];
		const errors: HostError[] = [];
		const h = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			onError: (e) => errors.push(e),
		});
		const facets = [
			{ name: "@test/access", facet: accessFacet() },
			{ name: "@test/doc", facet: docFacet({ built: [], admit: admitBy(true) }, Doc, shares) },
		];
		await h.load(facets, context);
		const access = await h.get(Access, {}, context);
		await access.set({ who: "server", mode: "read" }, context);
		const doc = await h.get(Doc, { id: "a" }, context);
		await access.set({ who: "server", mode: "write" }, context);
		await delivered();
		await access.set({ who: "server", mode: "none" }, context);
		await delivered();
		await access.set({ who: "server", mode: "read" }, context);
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		// One `Share(a)` through three rebuilds and a denial (it has no linger: a gap would have ended it).
		expect(shares).toEqual(["a"]);
		doc.release();
		await delivered();
		// Released with the object: the next holder's admission makes a new one.
		(await h.get(Doc, { id: "a" }, context)).release();
		expect(shares).toEqual(["a", "a"]);
		expect(errors).toEqual([]);
		await h.close(context);
	});

	it("stay with a sealed attempt while no later admission bound: a retry finds its source still held", async () => {
		const { h, reload } = await served({ built: [], admit: admitBy(true) }, { mode: "read" });
		const doc = await h.get(Doc, { id: "kept" }, context);
		let runs = 0;
		// Staging records the first run; the successor's own run throws before it declares anything.
		const flaky: Admit<typeof Doc, TestPrincipal> = (params, principal, self) => {
			if (++runs === 2) throw new Error("admit threw");
			return admitBy(true)(params, principal, self);
		};
		expect((await reload({ doc: docFacet({ built: [], admit: flaky }) })).failed).toEqual([]);
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		doc.retry();
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		// The share was held by the sealed attempt's admission throughout: it never ended, so no second object.
		expect(started.filter((label) => label === "test.share(kept)")).toEqual(["test.share(kept)"]);
		await h.close(context);
	});

	it("are collected with their decisions once the object ends", async () => {
		const { h, set } = await served({ built: [] }, { mode: "read" });
		const before = decisions.length;
		const doc = await h.get(Doc, { id: "gc" }, context);
		await set("write");
		await delivered();
		await set("none");
		await delivered();
		doc.release();
		await delivered();
		const made = decisions.slice(before);
		expect(made.length).toBe(3);
		await expectCollected(...made);
		await h.close(context);
	});

	it("cost one decision read per change of a source, and no factory run for an equal one", async () => {
		const { telemetry, counts } = await metered();
		const built: string[] = [];
		const h = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			telemetry,
			onError: () => {},
		});
		const facets = [
			{ name: "@test/access", facet: accessFacet() },
			{ name: "@test/doc", facet: docFacet({ built }) },
		];
		await h.load(facets, context);
		const access = await h.get(Access, {}, context);
		await access.set({ who: "server", mode: "read" }, context);
		const doc = await h.get(Doc, { id: "a" }, context);
		const before = counts()["chord.derive.computes"] ?? 0;
		await access.set({ who: "guest", mode: "read" }, context);
		// The store's `modes` derive and the admission's derive over it: one compute each, nothing else.
		expect((counts()["chord.derive.computes"] ?? 0) - before).toBe(2);
		expect(built).toEqual(["a:read"]);
		doc.release();
		await h.close(context);
	});
});

describe("presence, linger, parked_long and retry", () => {
	it("lists a holder from its first allow until a denial", async () => {
		const { h, set } = await served({ built: [] });
		const present = h.references(Doc);
		const doc = h.hold(Doc, { id: "a" }, context);
		await delivered();
		expect(present.value).toEqual([]);
		await set("read");
		await delivered();
		expect(present.value.map(({ params }) => params)).toEqual([{ id: "a" }]);
		// Another allowed value rebuilds the object: its holder stays listed.
		await set("write");
		expect(present.value.length).toBe(1);
		await delivered();
		await set("none");
		expect(present.value).toEqual([]);
		// A list made while denied shows none either.
		expect(h.references(Doc).value).toEqual([]);
		doc.release();
		await h.close(context);
	});

	it("unlists a holder when the attempt that parks denied is not one a seal started with the denial", async () => {
		const { h, set } = await served({ built: [] }, { mode: "read" });
		const present = h.references(Doc);
		const doc = await h.get(Doc, { id: "a" }, context);
		// The source fails: the object waits on it, still listed (no denial yet).
		await set("throw");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(present.value.length).toBe(1);
		// The parked attempt reads the denial itself.
		await set("none");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(present.value).toEqual([]);
		doc.release();
		await h.close(context);
	});

	it("ends a lingering object without holders when its decision changes", async () => {
		const built: string[] = [];
		const { h, set } = await served({ built, linger: 60_000 }, { mode: "read" });
		(await h.get(Doc, { id: "a" }, context)).release();
		await delivered();
		expect(h.activity.value.lingering).toBe(1);
		await set("write");
		await delivered();
		// Ended, not rebuilt for nobody.
		expect(h.activity.value.lingering).toBe(0);
		expect(built).toEqual(["a:read"]);
		await h.close(context);
	});

	it("reports no parked_long for a denial, of the object or of a dependent parked on it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
		try {
			const { h, errors } = await served({ built: [] }, { readyTimeout: 50 });
			const doc = h.hold(Doc, { id: "a" }, context);
			const panel = h.hold(Panel, { id: "a" }, context);
			await vi.advanceTimersByTimeAsync(10);
			expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
			expect(panel.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
			await vi.advanceTimersByTimeAsync(500);
			expect(reports(errors)).toEqual([]);
			doc.release();
			panel.release();
			await h.close(context);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ref.retry() on a denied object starts nothing; on one parked on a failed source it passes on", async () => {
		const built: string[] = [];
		const broken = { on: false };
		const { h, set, reload } = await served({ built });
		const doc = h.hold(Doc, { id: "a" }, context);
		await delivered();
		const made = decisions.length;
		doc.retry();
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(decisions.length).toBe(made);
		// The source fails (its new code's native does not open): the allowed object waits on it instead.
		await set("read");
		await delivered();
		broken.on = true;
		await reload({ access: accessFacet({ broken }) });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		broken.on = false;
		doc.retry();
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read", "a:read"]);
		doc.release();
		await h.close(context);
	});
});

describe("declaration errors", () => {
	/** The errors of a load of one facet. */
	async function refused(setup: (facet: FacetHost<TestPrincipal>) => void): Promise<string[]> {
		const h = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const { failed } = await h.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>(setup) }], context);
		await h.close(context);
		return failed.map(({ error }) => (error as Error).message);
	}

	it("refuse an admission without admit, admit without an admission, and either on a local type", async () => {
		const Plain = remote("test.plain", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: { n: int() },
		});
		const serve = (facet: FacetHost<TestPrincipal>) => facet.serve as (...args: unknown[]) => void;
		const factory = () => ({ n: constant(1) });
		const admit = () => constant(allow({ mode: "read" }));
		expect(await refused((facet) => serve(facet)(Doc, factory))).toEqual([
			'plugin "@test/app": test.doc: its contract takes an admission (its admission, grantable members or flags): serve it with admit',
		]);
		expect(await refused((facet) => serve(facet)(Plain, factory, { admit }))).toEqual([
			'plugin "@test/app": test.plain: admit needs an admission, grantable members or flags in the contract',
		]);
		expect(await refused((facet) => serve(facet)(Share, () => ({ open: constant("yes") }), { admit }))).toEqual([
			'plugin "@test/app": test.share: only a remote type takes an admission (admit)',
		]);
	});

	it("break the attempt: a job in an admitted factory, a declaration outside admit's four, a value that is no decision", async () => {
		const job = await served(
			{ built: [], declare: (self) => void self.job(Work, { run: async () => 1 }) },
			{ mode: "read" },
		);
		expect(told(await rejection(job.h.get(Doc, { id: "a" }, context))).message).toContain(
			"test.doc(a): self.job is not declared in an admitted object: work for a person lives in a local store",
		);
		await job.h.close(context);

		const outside = await served({
			built: [],
			admit: (_params, _principal, self) => {
				(self as unknown as Self<TestPrincipal>).writable(1);
				return constant(allow({ mode: "read" as const }));
			},
		});
		expect(((await rejection(outside.h.get(Doc, { id: "a" }, context))) as Error).message).toContain(
			"writable is not a function",
		);
		await outside.h.close(context);

		const admit = (() => constant({ kind: "maybe" })) as unknown as Admit<typeof Doc, TestPrincipal>;
		const value = await served({ built: [], admit });
		expect(told(await rejection(value.h.get(Doc, { id: "a" }, context))).message).toBe(
			"test.doc(a): its admission's value is neither allow(value) nor deny(reason)",
		);
		await value.set("read");
		const plain = (() => allow({ mode: "read" })) as unknown as Admit<typeof Doc, TestPrincipal>;
		await value.reload({ doc: docFacet({ built: [], admit: plain }) });
		expect(told(await rejection(value.h.get(Doc, { id: "b" }, context))).message).toContain(
			"test.doc(b): admit returns a JSON watchable of allow(value) or deny(reason)",
		);
		await value.h.close(context);
	});
});

describe("over a link", () => {
	/** A server serving `Access` and `Doc`, and a client (an owner) connected to it. */
	async function overLink(code: DocCode = { built: [] }) {
		const linkedHosts = await linked((facet) => {
			accessFacet().setup(facet, { contribute: () => {} });
			docFacet(code).setup(facet, { contribute: () => {} });
		});
		const access = await linkedHosts.server.get(Access, {}, context);
		const set = (mode: string) => access.set({ who: "owner", mode }, context);
		return { ...linkedHosts, set };
	}

	it("a denied hold is failed { denied }; a denial of a bound one drops its replicas, an allow binds it again", async () => {
		const { server, client, set } = await overLink();
		const doc = client.hold(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		await delivered();
		expect(doc.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no access" } },
		});
		expect(told(await rejection(client.get(Doc, { id: "a" }, context)))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		await set("write");
		await delivered();
		expect([doc.state.value.kind, role(doc), doc.text.value]).toEqual(["live", "writer", "t"]);
		const frames = changesOf(await doc.text.watch(context));
		await set("none");
		await delivered();
		expect(role(doc)).toBe(undefined);
		expect(told(await rejection((async () => doc.text.value)()))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		expect(valuesOf(frames)).toEqual([{ failed: "no access" }]);
		await set("read");
		await delivered();
		expect([doc.state.value.kind, role(doc), doc.text.value]).toEqual(["live", "reader", "t"]);
		expect(valuesOf(frames)).toEqual([{ failed: "no access" }, "t"]);
		expect(states).toEqual(["failed: no access", "loading", "live", "failed: no access", "loading", "live"]);
		doc.release();
		await client.close(context);
		await server.close(context);
	});

	it("a denial's message reaches the holder over the link (slice 15 §2)", async () => {
		const { server, client, set } = await overLink({ built: [], admit: messageAdmit });
		await set("deny:noShare");
		const doc = client.hold(Doc, { id: "a" }, context);
		await vi.waitFor(() => expect(messageOf(doc)).toEqual({ namespace: "docs", key: "noShare", params: ["owner"] }));
		await set("deny:later");
		await vi.waitFor(() => expect(messageOf(doc)).toMatchObject({ key: "later" }));
		doc.release();
		await client.close(context);
		await server.close(context);
	});

	it("a running call is answered forbidden/revoked by a denial, unavailable by another value", async () => {
		const { server, client, set } = await overLink({ built: [], gate: new Promise<void>(() => {}) });
		await set("write");
		const doc = await client.get(Doc, { id: "a" }, context);
		const first = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await delivered();
		await set("none");
		expect(told(await first)).toMatchObject({ code: "forbidden", reason: "revoked" });
		await set("write");
		await delivered();
		const second = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await delivered();
		await set("read");
		expect(told(await second)).toMatchObject({ code: "unavailable" });
		await client.close(context);
		await server.close(context);
	});

	it("a call still waiting for a call-window slot at a denial is rejected forbidden/revoked, as one in flight, and never sent", async () => {
		const server = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			callWindow: 1,
			onError: () => {},
		});
		const ran: string[] = [];
		const write = async (text: string) => void ran.push(text);
		const facets = [
			{ name: "@test/access", facet: accessFacet() },
			{ name: "@test/doc", facet: docFacet({ built: [], gate: new Promise<void>(() => {}), write }) },
		];
		await server.load(facets, context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		const access = await server.get(Access, {}, context);
		await access.set({ who: "owner", mode: "write" }, context);
		const doc = await client.get(Doc, { id: "a" }, context);
		const writer = { write: doc.write! };
		// The server announced a window of one call: the others wait at the consumer. The running call's answer frees
		// its slot, so the second is sent and crosses the `failed` on the wire; the third still waits when it arrives.
		const running = rejection(writer.write("running", context));
		const crossing = rejection(writer.write("crossing", context));
		const waiting = rejection(writer.write("waiting", context));
		await delivered();
		await access.set({ who: "owner", mode: "none" }, context);
		const revokedCall = { code: "forbidden", reason: "revoked", message: "test.doc(a): no access" };
		expect([told(await running), told(await crossing), told(await waiting)]).toEqual([
			revokedCall,
			revokedCall,
			revokedCall,
		]);
		await delivered();
		expect(ran).toEqual([]);
		// A call first made after the denial meets the denied reference: its plain `forbidden`.
		expect(told(await rejection(writer.write("late", context)))).toEqual({ code: "forbidden", message: "no access" });
		await client.close(context);
		await server.close(context);
	});

	it("a second reference joins a denied hold and shows the denial; both go live with the allow", async () => {
		const { server, client, set } = await overLink();
		const first = client.hold(Doc, { id: "a" }, context);
		await delivered();
		const second = client.hold(Doc, { id: "a" }, context);
		expect(second.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		await set("read");
		await delivered();
		expect([first.state.value.kind, second.state.value.kind]).toEqual(["live", "live"]);
		// One wire hold: one object, one presence entry.
		expect(server.references(Doc).value.length).toBe(1);
		await client.close(context);
		await server.close(context);
	});

	it("host.revoke ends a denied principal's object: its admission's requests go with it", async () => {
		const errors: HostError[] = [];
		const server = createHost<TestPrincipal, string>({
			address: Server(),
			principal: { kind: "server" },
			revokedBy: (principal) => (principal.kind === "owner" ? ["owner"] : []),
			onError: (error) => errors.push(error),
		});
		const facets = [
			{ name: "@test/access", facet: accessFacet() },
			{ name: "@test/doc", facet: docFacet({ built: [] }) },
		];
		await server.load(facets, context);
		const client = createHost<TestPrincipal>({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		const before = decisions.length;
		const doc = client.hold(Doc, { id: "a" }, context);
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(server.activity.value.references).toBe(1);
		server.revoke("owner", context);
		await delivered();
		expect(server.activity.value.references).toBe(0);
		await expectCollected(...decisions.slice(before));
		expect(errors).toEqual([]);
		await client.close(context);
		await server.close(context);
	});
});

describe("a reload of an admission's source (test 20)", () => {
	it("to an equal decision: the running call completes, nothing is rebuilt, the decision is kept while the source loads", async () => {
		const built: string[] = [];
		const natives: string[] = [];
		const gate = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		const code = { built, gate: gate.promise, opened: Promise.resolve(), natives };
		const { h, errors, reload } = await served(code, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const states = statesOf(await doc.state.watch(context));
		const writing = doc.write ? doc.write("x", context) : undefined;
		// The source's successor stays loading until its native opens: the last decision is kept meanwhile.
		const report = await reload({ access: accessFacet({ opened: opened.promise }) });
		expect(report.objects).toEqual([{ object: "test.access", kind: "restarted" }]);
		await delivered();
		const access = h.hold(Access, {}, context);
		expect(access.state.value.kind).toBe("loading");
		expect(doc.state.value.kind).toBe("live");
		gate.resolve();
		expect(await writing).toBe("write:x");
		opened.resolve();
		await delivered();
		expect(access.state.value.kind).toBe("live");
		// The modes are the store's documents: the same decision, no new attempt, no native reopened.
		expect(built).toEqual(["a:write"]);
		expect(natives).toEqual(["open"]);
		expect(states).toEqual([]);
		expect(errors).toEqual([]);
		access.release();
		await h.close(context);
	});

	it("whose successor parks seals its readers, which rebuild once it is back", async () => {
		const built: string[] = [];
		const { h, reload } = await served({ built }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		await reload({ access: accessFacet({ needsMissing: true }) });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((doc.state.value as { cause: { error: Error } }).cause.error.message).toBe(
			"waiting for test.access: test.missing is not served here",
		);
		await reload({ access: accessFacet() });
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read", "a:read"]);
		await h.close(context);
	});

	it("whose contract is bumped without accepts seals its readers until their code follows; with accepts it seals nothing", async () => {
		const built: string[] = [];
		const { h, reload } = await served({ built }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		// Version 1 still bound through `accepts` (an added member needs no mapping): the reader is untouched.
		await reload({ access: accessFacet({}, AccessV2, { 1: {} }) });
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read"]);
		// Without `accepts` the reader's version is refused: failed, not loading, so it fails closed.
		await reload({ access: accessFacet({}, AccessV2) });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((doc.state.value as { cause: { error: Error } }).cause.error.message).toContain("test.access v1");
		await reload({ access: accessFacet({}, AccessV2, { 1: {} }) });
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read", "a:read"]);
		await h.close(context);
	});

	it("that removes it parks its readers on it; serving it again rebuilds them", async () => {
		const built: string[] = [];
		const { h, set, reload } = await served({ built }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const none = defineFacet<TestPrincipal>(() => {});
		await reload({ access: none });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await reload({ access: accessFacet() });
		// A new store object: its modes start over, and the reader is denied until it is allowed again.
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		await set("read");
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read", "a:read"]);
		await h.close(context);
	});
});

describe("a reload of the admitted type (2.5, test 20)", () => {
	it("records the new admit without effects and rehearses the new factory with an equal admission fingerprint", async () => {
		const built: string[] = [];
		const shares: string[] = [];
		const { h, reload } = await served({ built }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const rehearsed: string[] = [];
		const failing = docFacet(
			{
				built: rehearsed,
				admit: admitBy(true),
				declare: () => {
					throw new Error("the new factory throws");
				},
			},
			Doc,
			shares,
		);
		const report = await reload({ doc: failing });
		// Rehearsed with the object's current value: its throw keeps the plugin on its old code.
		expect(rehearsed).toEqual(["a:read"]);
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			["@test/doc", 'plugin "@test/doc", test.doc(a): the new factory throws'],
		]);
		// The recorded `admit` declared a share: nothing was made for it.
		expect(shares).toEqual([]);
		expect(doc.state.value.kind).toBe("live");
		expect(built).toEqual(["a:read"]);
		await h.close(context);
	});

	it("does not rehearse across another admission fingerprint, or without a value: the factory's error is its activation's", async () => {
		const { h, errors, set, reload } = await served({ built: [] }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const rehearsed: string[] = [];
		const job = (self: Self<TestPrincipal>) => void self.job(Work, { run: async () => 1 });
		// Another fingerprint: the plugin applies, and the refused job fails the restarted object.
		const other = await reload({ doc: docFacet({ built: rehearsed, declare: job }, DocV2) });
		expect(other.failed).toEqual([]);
		expect(rehearsed).toEqual([]);
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		expect(reports(errors).filter((report) => report.includes("self.job")).length).toBe(1);
		// No value (the object is denied): not rehearsed either, reported when it is allowed.
		await reload({ doc: docFacet({ built: [] }) });
		await set("none");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		errors.length = 0;
		const ran: string[] = [];
		const denied = await reload({ doc: docFacet({ built: ran, declare: job }) });
		expect(denied.failed).toEqual([]);
		expect([ran, reports(errors)]).toEqual([[], []]);
		await set("read");
		await delivered();
		expect(ran).toEqual(["a:read"]);
		expect(reports(errors).filter((report) => report.includes("self.job")).length).toBe(1);
		await h.close(context);
	});

	it("a dependency only the newly admitted branch declares parks the object after the commit", async () => {
		const { h, set, reload } = await served({ built: [] }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const declare = (self: Self<TestPrincipal>, mode: string) => {
			if (mode === "write") self.get(Missing, {});
		};
		// Rehearsed as a reader: the writer's request is not recorded.
		expect((await reload({ doc: docFacet({ built: [], declare }) })).failed).toEqual([]);
		await delivered();
		expect(doc.state.value.kind).toBe("live");
		await set("write");
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await h.close(context);
	});

	it("a denial between staging and activation: the new factory never runs", async () => {
		const built: string[] = [];
		const { h, set, reload } = await served({ built: [] }, { mode: "read" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const reloading = reload({ doc: docFacet({ built }) });
		await set("none");
		await reloading;
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		// Staging rehearsed it once; no attempt ran it.
		expect(built).toEqual(["a:read"]);
		await h.close(context);
	});

	it("a decision change while its old attempt drains seals that attempt at once", async () => {
		const built: string[] = [];
		const gate = Promise.withResolvers<void>();
		const { h, errors, set, reload } = await served({ built: [], gate: gate.promise }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await reload({ doc: docFacet({ built }) });
		// The old attempt drains its call; its successor waits for it.
		expect(doc.state.value.kind).toBe("live");
		const present = h.references(Doc);
		expect(present.value.length).toBe(1);
		await set("none");
		// The cut is the denial's flush, not the successor's later admission: no value, no presence, from here on.
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(() => doc.text.value).toThrow("no access");
		expect(present.value).toEqual([]);
		expect(told(await writing)).toMatchObject({ code: "forbidden", reason: "revoked" });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(built).toEqual(["a:write"]);
		// Nothing failed in the flush that cut it (a reference released there would have).
		expect(errors).toEqual([]);
		gate.resolve();
		await h.close(context);
	});

	it("a denial while its old attempt drains is shown by that attempt's own decision, whatever its successor's admission waits for", async () => {
		const gate = Promise.withResolvers<void>();
		const { h, set, reload } = await served({ built: [], gate: gate.promise }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		// The new admission also needs a type nobody serves: the successor parks on it and decides nothing.
		const waits: Admit<typeof Doc, TestPrincipal> = (params, principal, self) => {
			self.get(Missing, {});
			return admitBy()(params, principal, self);
		};
		await reload({ doc: docFacet({ built: [], admit: waits }) });
		await delivered();
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(doc.text.value).toBe("t");
		await set("none");
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(() => doc.text.value).toThrow("no access");
		expect(told(await writing)).toMatchObject({ code: "forbidden", reason: "revoked" });
		gate.resolve();
		await h.close(context);
	});

	it("another value while its old attempt drains seals that attempt: its call is rejected unavailable, its holders load", async () => {
		const built: string[] = [];
		const gate = Promise.withResolvers<void>();
		const { h, errors, set, reload } = await served({ built: [], gate: gate.promise }, { mode: "write" });
		const doc = await h.get(Doc, { id: "a" }, context);
		const writing = rejection(doc.write ? doc.write("x", context) : Promise.resolve());
		await reload({ doc: docFacet({ built }) });
		await set("read");
		expect([doc.state.value.kind, doc.text.value]).toEqual(["loading", "t"]);
		expect(told(await writing)).toMatchObject({ code: "unavailable" });
		gate.resolve();
		await delivered();
		expect([doc.state.value.kind, role(doc)]).toEqual(["live", "reader"]);
		expect(errors).toEqual([]);
		await h.close(context);
	});

	it("a decision change while the attempt opens a native abandons it: the native closes, the next attempt admits", async () => {
		const built: string[] = [];
		const natives: string[] = [];
		const opened = Promise.withResolvers<void>();
		const { h, set } = await served({ built, opened: opened.promise, natives }, { mode: "read" });
		const doc = h.hold(Doc, { id: "a" }, context);
		await delivered();
		expect(built).toEqual(["a:read"]);
		expect(doc.state.value.kind).toBe("loading");
		await set("none");
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		opened.resolve();
		await delivered();
		// Opened after its attempt was abandoned: closed at once, and nothing went live.
		expect(natives).toEqual(["open", "close"]);
		expect(doc.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		doc.release();
		await h.close(context);
	});
});

describe("an admission that reads a named query", () => {
	const Item = obj({ id: str() });
	const Items = defineTable("items", { version: 1, columns: { id: str() }, key: ["id"] });
	const Shelf = local("test.shelf", {
		version: 1,
		params: {},
		members: { items: queries(Item, { all: obj({}) }), put: method(str()) },
	});
	const Reader = remote("test.reader", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		admission: obj({ shelf: str() }),
		state: { label: str() },
	});

	/** A facet serving `Reader`, whose admission reads the shelf's items live. */
	const readerFacet = () =>
		defineFacet<TestPrincipal>((facet) =>
			facet.serve(Reader, () => ({ label: constant("x") }), {
				admit: (_params, _principal, self) => {
					const items = self.liveQuery(self.get(Shelf, {}).items.all, {}, { first: 3 });
					return self.derive([items], () => allow({ shelf: "yes" }));
				},
			}),
		);

	it("parked on a read that failed is its attempt's first check: a reload of its type reports it and does not wait for the read", async () => {
		const failing = { on: false };
		const store = await memoryStore();
		const h = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: () => {},
		});
		const shelf = defineFacet<TestPrincipal>((facet) =>
			facet.serve(Shelf, (_, self) => {
				const rows = self.table(Items);
				const map = (row: { id: string }) => {
					if (failing.on) throw new Error("the mapping is unavailable");
					return row;
				};
				return {
					items: self.queries(
						rows,
						{ map },
						{ all: (_args: Record<string, never>) => query(Items).orderBy((item) => item.id) },
					),
					put: async (id, ctx) => {
						await self.tx(async (tx) => tx.put(rows, { id }), ctx);
						return null;
					},
				};
			}),
		);
		const plugins = (reader = readerFacet()) => [
			{ name: "@test/shelf", facet: shelf },
			{ name: "@test/reader", facet: reader },
		];
		await h.load(plugins(), context);
		const api = await h.get(Shelf, {}, context);
		await api.put("a", context);
		const held = await h.get(Reader, {}, context);
		// The read's next run fails: the decision cannot be read, so the object is sealed and parks on the read.
		failing.on = true;
		await api.put("b", context);
		await delivered();
		expect(held.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		const reloading = h.reload(plugins(), context);
		const pending = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200));
		const report = await Promise.race([reloading, pending]);
		expect(report).not.toBe("pending");
		expect(report).toMatchObject({
			objects: [{ object: "test.reader", kind: "parked", cause: { kind: "waiting" } }],
		});
		// The read recovers: the parked attempt goes on.
		failing.on = false;
		await api.put("c", context);
		await delivered();
		expect(held.state.value.kind).toBe("live");
		await h.close(context);
		await store.close(context);
	});
});

describe("a commit in flight at the cut", () => {
	it("stays durable; the sealed attempt publishes nothing after it", async () => {
		const store = await memoryStore();
		const errors: HostError[] = [];
		const h = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (error) => errors.push(error),
		});
		const write = async (text: string, self: Self<TestPrincipal>) => {
			await h.root(async (ctx) => (await ctx.get(Journal, {})).append(text, ctx), context);
			void self;
		};
		await h.load(
			[
				{ name: "@test/access", facet: accessFacet() },
				{ name: "@test/doc", facet: docFacet({ built: [], write }) },
				{ name: "@test/journal", facet: journalFacet },
			],
			context,
		);
		const access = await h.get(Access, {}, context);
		await access.set({ who: "server", mode: "write" }, context);
		const doc = await h.get(Doc, { id: "a" }, context);
		const frames = changesOf(await doc.text.watch(context));
		const held = holdNextCommit(store);
		const writing = rejection(doc.write ? doc.write("kept", context) : Promise.resolve());
		await held.entered;
		// The cut, with the journal's commit admitted and its step running.
		await access.set({ who: "server", mode: "none" }, context);
		expect(told(await writing)).toMatchObject({ code: "forbidden", reason: "revoked" });
		held.release();
		await delivered();
		const journal = await h.get(Journal, {}, context);
		expect(await journal.has("kept", context)).toBe(1);
		// The handler ran on past the commit; its own change was refused, and the denied holder got the denial alone.
		expect(valuesOf(frames)).toEqual([{ failed: "no access" }]);
		await h.close(context);
		await store.close(context);
	});
});

describe("what a decision keeps (hold memory)", () => {
	/** A thing: plain and grantable members and a flag; admitted by the names a shared object lists. */
	const Thing = remote("heap.thing", {
		version: 1,
		params: { id: str() },
		hostAddress: () => Server(),
		state: { name: str() },
		methods: { use: method(str(), str()), add: grantable(method(str(), str())) },
		flags: { export: "Export" },
	});
	const Roles = local("heap.roles", { version: 1, params: {}, members: { names: map(str()) } });

	function things(host: FacetHost<TestPrincipal>): void {
		host.serve(Roles, () => ({ names: constant({ owner: "add" }) }));
		host.serve(Thing, ({ id }) => ({ name: constant(id), use: async (text) => text, add: async (text) => text }), {
			admit: (_params, principal, self) =>
				self.derive([self.get(Roles, {}).names], ([names]) =>
					names[principal.kind] === "add" ? allow({ granted: ["add", "export"] }) : allow({}),
				),
		});
	}

	it("decisions granting the same names share one set", async () => {
		const { server, client } = await linked(things, { child: { kind: "owner" } });
		const first = await client.get(Thing, { id: "a" }, context);
		const second = await client.get(Thing, { id: "b" }, context);
		expect([[...first.granted], [...second.granted]]).toEqual([
			["add", "export"],
			["add", "export"],
		]);
		const granted = objects
			.map((object) => object.deref())
			.filter((object) => object?.label.startsWith("heap.thing(") === true)
			.map((object) => object!.granted);
		expect(granted.length).toBe(2);
		expect(granted[0]).toBe(granted[1]);
		first.release();
		second.release();
		await client.close(context);
		await server.close(context);
	});

	// Found by the review of the hold-memory pass (2026-11-25): shared sets were kept for the contract's life.
	it("a set of names no decision grants any more is collected while its contract is served (255 combinations)", async () => {
		const Flagged = remote("heap.flagged", {
			version: 1,
			params: { n: int() },
			hostAddress: () => Server(),
			state: { name: str() },
			flags: { f0: "0", f1: "1", f2: "2", f3: "3", f4: "4", f5: "5", f6: "6", f7: "7" },
		});
		const flags = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"] as const;
		const namesOf = (n: number) => flags.filter((_, index) => (n & (1 << index)) !== 0);
		const errors: HostError[] = [];
		const onError = (error: HostError) => void errors.push(error);
		const h = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError });
		const facet = defineFacet<TestPrincipal>((host) =>
			host.serve(Flagged, () => ({ name: constant("n") }), {
				admit: ({ n }) => constant(allow({ granted: namesOf(n) })),
			}),
		);
		await h.load([{ name: "@test/flags", facet }], context);
		// In a function of its own: the last reference stays in no variable of this test.
		const granted = async (): Promise<WeakRef<ReadonlySet<string>>[]> => {
			const sets: WeakRef<ReadonlySet<string>>[] = [];
			for (let n = 1; n < 256; n++) {
				const reference = await h.get(Flagged, { n }, context);
				sets.push(new WeakRef(reference.granted));
				reference.release();
			}
			return sets;
		};
		await expectCollected(...(await granted()));
		// Granted again: a set of the same names.
		const again = await h.get(Flagged, { n: 5 }, context);
		expect([[...again.granted], errors]).toEqual([["f0", "f2"], []]);
		again.release();
		await h.close(context);
	});

	// Found by the wire builder's review (2026-11-26): the registry's holdings named the version's table, so a set an
	// app kept kept the table and its entries after the version was gone.
	it("a version gone keeps no table or entry of its granted sets, while an app keeps every set", async () => {
		const tables: WeakRef<object>[] = [];
		const entries: WeakRef<object>[] = [];
		const set = Map.prototype.set;
		// Watches the insertions into the version's table only: it keeps neither the table nor its entries.
		Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
			const first: unknown = Array.isArray(value) ? value[0] : undefined;
			const held = first instanceof WeakRef ? first.deref() : undefined;
			if (typeof key === "number" && held instanceof Set && [...held].some((name) => `${name}`.startsWith("kept"))) {
				tables.push(new WeakRef(this));
				entries.push(new WeakRef(value as object), new WeakRef(first as object));
			}
			return set.call(this, key, value);
		};
		let kept: { readonly version: WeakRef<object>; readonly sets: ReadonlySet<string>[] };
		try {
			kept = await (async () => {
				const flags = ["kept0", "kept1", "kept2", "kept3", "kept4"] as const;
				const Kept = remote("heap.kept-sets", {
					version: 1,
					params: { n: int() },
					hostAddress: () => Server(),
					state: { name: str() },
					flags: { kept0: "0", kept1: "1", kept2: "2", kept3: "3", kept4: "4" },
				});
				const h = createHost<TestPrincipal>({
					address: Server(),
					principal: { kind: "server" },
					onError: () => {},
				});
				const facet = defineFacet<TestPrincipal>((host) =>
					host.serve(Kept, () => ({ name: constant("n") }), {
						admit: ({ n }) => constant(allow({ granted: flags.filter((_, index) => (n & (1 << index)) !== 0) })),
					}),
				);
				await h.load([{ name: "@test/kept", facet }], context);
				const sets: ReadonlySet<string>[] = [];
				for (let n = 1; n < 32; n++) {
					const reference = await h.get(Kept, { n }, context);
					sets.push(reference.granted);
					reference.release();
				}
				await h.close(context);
				return { version: new WeakRef(currentVersion(Kept)), sets };
			})();
		} finally {
			Map.prototype.set = set;
		}
		expect(tables.length).toBeGreaterThan(0);
		await expectCollected(kept.version);
		await expectCollected(...tables, ...entries);
		expect(kept.sets.at(-1)!.size).toBe(5);
	});

	it("sets of names whose hashes collide (more than 31 grants) are told apart name by name", async () => {
		const names = Array.from({ length: 40 }, (_, index) => `g${String(index).padStart(2, "0")}`);
		const Many = remote("heap.many", {
			version: 1,
			params: { n: int() },
			hostAddress: () => Server(),
			state: { name: str() },
			// Typed by a template: a plain record of strings would claim every name, `name` too.
			flags: Object.fromEntries(names.map((name) => [name, name])) as Record<`g${number}`, string>,
		});
		// g00 and g31 are indexes 0 and 31 of the sorted grants: one hash.
		const lists: `g${number}`[][] = [["g00"], ["g31"], ["g31", "g00"], ["g00", "g31", "g00"], ["g31"]];
		const h = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((host) =>
			host.serve(Many, () => ({ name: constant("n") }), {
				admit: ({ n }) => constant(allow({ granted: lists[n]! })),
			}),
		);
		await h.load([{ name: "@test/many", facet }], context);
		const held = [];
		for (let n = 0; n < lists.length; n++) held.push(await h.get(Many, { n }, context));
		expect(held.map((reference) => [...reference.granted])).toEqual([
			["g00"],
			["g31"],
			["g00", "g31"],
			["g00", "g31"],
			["g31"],
		]);
		expect(held[0]!.granted).not.toBe(held[1]!.granted);
		expect(held[2]!.granted).toBe(held[3]!.granted);
		expect(held[4]!.granted).toBe(held[1]!.granted);
		for (const reference of held) reference.release();
		await h.close(context);
	});

	it("an admitted object held over a link, its admission reading one reference: under 14 KiB at both ends", async () => {
		const { server, client } = await linked(things, { child: { kind: "owner" } });
		const hold = async (from: number, to: number) => {
			const references = [];
			for (let id = from; id < to; id++) references.push(await client.get(Thing, { id: `t${id}` }, context));
			return references;
		};
		// A warm-up first: what the first holds make for good (compiled code, caches) is no hold's.
		const warm = await hold(0, 300);
		const before = await settledHeap();
		const held = await hold(300, 2_300);
		const each = ((await settledHeap()) - before) / held.length;
		// Measured 11.6 KiB for both ends (the object, its attempt, decision, reference and derive here; the hold's
		// reference and replica there); 18.4 KiB when a decision followed each reference by a promise and an abort
		// listener under a signal joined with its attempt's, and every source kept a set for its one dependent.
		expect(each).toBeLessThan(14 * 1024);
		for (const reference of [...warm, ...held]) reference.release();
		await client.close(context);
		await server.close(context);
	}, 60_000);
});
