import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, keyed, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { loaded, rejection, Session } from "../support.ts";

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
