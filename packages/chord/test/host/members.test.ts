import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { type EventSource, event, int, keyed, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { constant } from "../../src/state/index.ts";
import { linked, loaded, rejection, Server, Session } from "../support.ts";

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
			variants: { v: { events: { ticks: Sample } } },
		});
		const { client } = await linked((h) =>
			h.serve(Only, (_, _principal, self) => ({ variant: "v", members: { ticks: self.events() } })),
		);
		const only = await client.get(Only, {}, context);
		expect(only.state.value).toEqual({ kind: "live" });
	});
});
