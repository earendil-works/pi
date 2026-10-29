import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { delivered, framesOf, loaded, rejection } from "../support.ts";

const List = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });
const Drafts = defineState("drafts", {
	schema: obj({ body: str() }),
	version: 1,
	initial: () => ({ body: "" }),
	keyed: true,
});
const Owner = local("app.owner", {
	version: 1,
	params: { id: int() },
	members: { list: obj({ items: arr(str()) }), touch: method() },
});

/** Serves `Owner` and hands out its handles. */
async function owner() {
	const handles: { list?: SingletonHandle<{ items: string[] }>; drafts?: KeyedHandle<{ body: string }> } = {};
	const { host } = await loaded((h) =>
		h.serve(Owner, (_, self) => {
			handles.list = self.state(List);
			handles.drafts = self.state(Drafts);
			return { list: handles.list, touch: async () => null };
		}),
	);
	const reference = await host.get(Owner, { id: 1 }, context);
	return { host, reference, list: handles.list!, drafts: handles.drafts! };
}

/** The keys a keyed handle lists. */
async function keysOf(handle: KeyedHandle<{ body: string }>): Promise<string[]> {
	const keys: string[] = [];
	for await (const key of handle.keys(context)) keys.push(key);
	return keys;
}

describe("singleton documents", () => {
	it("read initial() until written and again after a retire, whose frame replaces the root", async () => {
		const { list } = await owner();
		const initial = list.value;
		expect(initial).toEqual({ items: [] });
		const frames = framesOf(await list.watch(context));
		await list.change((draft) => draft.items.push("a"), context);
		expect(list.value).toEqual({ items: ["a"] });
		await list.retire(context);
		expect(list.value).toBe(initial);
		await list.retire(context);
		await delivered();
		expect(frames).toEqual([
			[{ items: ["a"] }, [["p", ["items"], 0, 0, ["a"]]]],
			[initial, [["r", initial]]],
		]);
	});

	it("throw not_ready when read in the factory", async () => {
		const { host } = await loaded((h) =>
			h.serve(Owner, (_, self) => {
				const list = self.state(List);
				void list.value;
				return { list, touch: async () => null };
			}),
		);
		await expect(host.get(Owner, { id: 1 }, context)).rejects.toThrow("list: read before activation");
	});
});

describe("keyed documents", () => {
	it("are absent until written; get, keys and retire by key", async () => {
		const { drafts } = await owner();
		expect(await drafts.get("a", context)).toBeUndefined();
		await drafts.change(
			"a",
			(draft) => {
				draft.body = "x";
			},
			context,
		);
		await drafts.change(
			"b",
			(draft) => {
				draft.body = "y";
			},
			context,
		);
		await drafts.change("c", () => {}, context);
		expect(await drafts.get("a", context)).toEqual({ body: "x" });
		expect(await keysOf(drafts)).toEqual(["a", "b"]);
		await drafts.retire("a", context);
		await drafts.retire("missing", context);
		expect(await drafts.get("a", context)).toBeUndefined();
		expect(await keysOf(drafts)).toEqual(["b"]);
	});
});

describe("when the owner ends", () => {
	it("documents are dropped: every use throws released and watches end", async () => {
		const { reference, list, drafts } = await owner();
		const watch = await list.watch(context);
		reference.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		const released = { code: "released", reason: "ended", message: "app.owner(1): ended" };
		expect(() => list.value).toThrow("app.owner(1): ended");
		expect(await rejection(drafts.get("a", context))).toEqual(released);
		expect(await rejection(keysOf(drafts))).toEqual(released);
		expect(await rejection(list.change(() => {}, context))).toEqual(released);
	});
});
