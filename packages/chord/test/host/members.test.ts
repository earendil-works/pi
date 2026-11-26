import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	type EventSource,
	event,
	evolve,
	int,
	keyed,
	local,
	method,
	obj,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { NO_GRANTS } from "../../src/contracts/internal.ts";
import { defineState } from "../../src/documents/index.ts";
import { checkImplementation } from "../../src/host/members.ts";
import { constant } from "../../src/state/index.ts";
import { expectCollected, linked, loaded, rejection, Server, Session } from "../support.ts";

describe("the member check (Q14)", () => {
	it("refuses an inherited property for a member", async () => {
		const Named = local("app.named", { version: 1, params: { id: int() }, members: { toString: method() } });
		const { host } = await loaded((h) => h.serve(Named, () => ({}) as never));
		await expect(host.get(Named, { id: 1 }, context)).rejects.toThrow(
			"app.named(1): toString: a method is a function",
		);
	});

	it("names a derive in errors by its member when exposed, else by its position", async () => {
		const Named = local("app.named", { version: 1, params: { n: int() }, members: { label: int() } });
		const bad = { value: 1 };
		const { host } = await loaded((h) =>
			h.serve(Named, ({ n }, self) => {
				const inner = self.derive(n === 1 ? [] : [bad as never], () => 1);
				return { label: self.derive(n === 1 ? [inner, bad as never] : [inner], () => 2) };
			}),
		);
		await expect(host.get(Named, { n: 1 }, context)).rejects.toThrow(
			"app.named(1): label: source 1 is not a Chord watchable",
		);
		await expect(host.get(Named, { n: 2 }, context)).rejects.toThrow(
			"app.named(2): derive #1: source 0 is not a Chord watchable",
		);
	});
});

describe("a checked implementation's methods and state members (hot-path pass)", () => {
	const Pair = local("app.pair", {
		version: 1,
		params: {},
		members: { b: str(), a: int(), go: method(), add: method(int(), int()) },
	});
	const implementation = () => ({
		a: constant(1),
		b: constant("b"),
		go: async () => null,
		add: async (n: number) => n + 1,
	});

	it("are maps in the contract's order: get, has, size, keys, values, entries, forEach", () => {
		const { state, methods } = checkImplementation(Pair, implementation(), undefined, NO_GRANTS);
		expect([state.size, [...state.keys()], state.has("a"), state.has("go"), state.get("x")]).toEqual([
			2,
			["b", "a"],
			true,
			false,
			undefined,
		]);
		expect([...state.values()]).toEqual([state.get("b"), state.get("a")]);
		expect([...state.entries()]).toEqual([...state]);
		expect([...state].map(([member]) => member)).toEqual(["b", "a"]);
		const seen: string[] = [];
		methods.forEach((call, member, map) => {
			expect([typeof call, map]).toEqual(["function", methods]);
			seen.push(member);
		});
		expect(seen).toEqual(["go", "add"]);
	});

	it("keep their contract's names for every object of the version, collected with the contract", async () => {
		const refs = (() => {
			const Short = local("app.short", { version: 1, params: {}, members: { a: int(), go: method() } });
			const make = () => checkImplementation(Short, { a: constant(1), go: async () => null }, undefined, NO_GRANTS);
			const [first, second] = [make(), make()];
			expect([[...first.methods.keys()], [...second.state.keys()]]).toEqual([["go"], ["a"]]);
			return [new WeakRef(Short), new WeakRef(first.state)];
		})();
		await expectCollected(...refs);
	});
});

// Found by the review of the hot-path pass (astra2, 2026-11-26): the positions of a version's members were cached
// for a members map a kept `evolve` editor changed since.
describe("a checked implementation's members after a kept editor changed them", () => {
	it("a state member removed and added again serves its own source on the next object", async () => {
		const First = local("review.pair", {
			version: 1,
			params: { id: int() },
			members: { first: int(), second: int() },
		});
		let moveFirst = () => {};
		const Second = evolve(First, (editor) => {
			moveFirst = () => {
				editor.removeState("first").addState("first", int());
			};
			return editor;
		});
		const { host } = await loaded((h) => h.serve(Second, () => ({ first: constant(1), second: constant(2) })));
		try {
			expect((await host.get(Second, { id: 1 }, context)).first.value).toBe(1);
			moveFirst();
			const another = await host.get(Second, { id: 2 }, context);
			expect([another.first.value, another.second.value]).toEqual([1, 2]);
		} finally {
			await host.close(context);
		}
	});
});

describe("host-keyed keyed members", () => {
	const Meta = defineState("meta", {
		schema: obj({ title: str() }),
		version: 1,
		initial: () => ({ title: "" }),
		keyed: Session,
	});
	const Plain = defineState("plain", {
		schema: obj({ title: str() }),
		version: 1,
		initial: () => ({ title: "" }),
		keyed: true,
	});
	const Store = local("test.meta-store", {
		version: 1,
		params: {},
		members: { meta: keyed(obj({ title: str() }), Session), set: method(obj({ id: str(), title: str() })) },
	});
	/** A per-session view pinning its session's document through the store's member. */
	const View = local("test.meta-view", {
		version: 1,
		params: { id: str() },
		members: { meta: obj({ title: str() }) },
	});

	it("are read by address through a reference, pinned by `at(address)` in another factory; strings refused", async () => {
		const { host } = await loaded((facet) => {
			facet.serve(Store, (_, self) => {
				const meta = self.state(Meta);
				return {
					meta,
					set: async ({ id, title }, ctx) => {
						await meta.change(
							Session({ id }),
							(draft) => {
								draft.title = title;
							},
							ctx,
						);
						return null;
					},
				};
			});
			facet.serve(View, ({ id }, self) => ({ meta: self.get(Store, {}).meta.at(Session({ id })) }));
		});
		const store = await host.get(Store, {}, context);
		await store.set({ id: "S1", title: "one" }, context);
		expect(await store.meta.get(Session({ id: "S1" }), context)).toEqual({ title: "one" });
		expect((await store.meta.watch(Session({ id: "S1" }), context))?.value).toEqual({ title: "one" });
		const view = await host.get(View, { id: "S1" }, context);
		expect(view.meta.value).toEqual({ title: "one" });
		await store.set({ id: "S1", title: "two" }, context);
		expect(view.meta.value).toEqual({ title: "two" });
		expect(await rejection(store.meta.get("session|S1" as never, context))).toMatchObject({
			code: "invalid",
			message: "meta: expected an address of session",
		});
		await host.close(context);
	});

	it("refuse a handle keyed otherwise", async () => {
		const { host } = await loaded((facet) =>
			facet.serve(Store, (_, self) => ({ meta: self.state(Plain) as never, set: async () => null })),
		);
		expect(await rejection(host.get(Store, {}, context))).toMatchObject({
			message: expect.stringContaining("meta: declared with addresses of session, implemented with string keys"),
		});
		await host.close(context);
	});
});

describe('event members (decision "Events: fire-and-forget members")', () => {
	const Sample = obj({ y: int() });
	const Ticks = local("app.ticks", { version: 1, params: { n: int() }, members: { ticks: event(Sample) } });

	it("fail the object broken for an implementation that is neither its own source nor a reference's event member", async () => {
		const others: EventSource<{ y: number }>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Ticks, ({ n }, self) => {
				const own = self.events<{ y: number }>();
				others.push(own);
				// 1: a plain object with `on`; 2: another attempt's source; 3: a state member.
				if (n === 1) return { ticks: { on: async () => ({ stop() {} }), emit() {} } as never };
				if (n === 2) return { ticks: others[0]! };
				if (n === 3) return { ticks: constant(1) as never };
				return { ticks: own };
			}),
		);
		expect((await host.get(Ticks, { n: 0 }, context)).ticks).toBeDefined();
		for (const n of [1, 2, 3]) {
			const error = await rejection(host.get(Ticks, { n }, context));
			expect(error).toMatchObject({
				message: `app.ticks(${n}): ticks: an event member is this object's own self.events() or a reference's event member`,
			});
		}
	});

	it("bind an event-only contract live: no state to hydrate, at once over a link too", async () => {
		const Only = remote("app.only", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			events: { ticks: Sample },
		});
		const { client } = await linked((h) => h.serve(Only, (_, _principal, self) => ({ ticks: self.events() })));
		const only = await client.get(Only, {}, context);
		expect(only.state.value).toEqual({ kind: "live" });
	});
});
