import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../src/documents/index.ts";
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

/** Serves `Owner` and hands out its handles; `errors` collects the host's background errors. */
async function owner() {
	const handles: { list?: SingletonHandle<{ items: string[] }>; drafts?: KeyedHandle<{ body: string }> } = {};
	const { host, errors } = await loaded((h) =>
		h.serve(Owner, (_, self) => {
			handles.list = self.state(List);
			handles.drafts = self.state(Drafts);
			return { list: handles.list, touch: async () => null };
		}),
	);
	const reference = await host.get(Owner, { id: 1 }, context);
	return { host, errors, reference, list: handles.list!, drafts: handles.drafts! };
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

describe('transactions their context\'s end cancelled (decision "Mistakes that wait are reported at once" (e))', () => {
	it("are reported besides rejecting: a change started in a root and not awaited, its fn settled first", async () => {
		const { host, errors, list } = await owner();
		let rejected: unknown;
		await host.root(async (ctx) => {
			// Footgun 10: the empty catch would hide a change that never happened.
			void list
				.change((draft) => draft.items.push("lost"), ctx)
				.catch((error) => {
					rejected = error;
				});
		}, context);
		await delivered();
		expect(list.value).toEqual({ items: [] });
		expect(rejected).toMatchObject({ code: "released", reason: "settled" });
		expect(errors).toEqual([
			{
				kind: "transaction_cancelled",
				object: "app.owner(1)",
				error: expect.objectContaining({ message: "host.root: its fn settled" }),
			},
		]);
		// Awaited inside the root (the rule: await what you start in a root or a handler), it commits.
		await host.root((ctx) => list.change((draft) => draft.items.push("kept"), ctx), context);
		expect([list.value, errors.length]).toEqual([{ items: ["kept"] }, 1]);
		await host.close(context);
	});

	it("are reported for a caller's cancellation while the change waits on the line", async () => {
		const { host, errors, list, drafts } = await owner();
		const gate = Promise.withResolvers<void>();
		const holding = drafts.change("a", () => gate.promise, context);
		const cancel = withCancel(context);
		const waiting = rejection(list.change((draft) => draft.items.push("lost"), cancel.context));
		cancel.cancel();
		gate.resolve();
		await holding;
		expect(await waiting).toMatchObject({ name: "AbortError" });
		expect(errors.map(({ kind }) => kind)).toEqual(["transaction_cancelled"]);
		await host.close(context);
	});

	it("cost nothing on the committed path: no check of the context beyond the commit's own (cost guard)", async () => {
		const { host, errors, list } = await owner();
		const reads = vi.spyOn(AbortSignal.prototype, "aborted", "get");
		const live = withCancel(context);
		try {
			for (let n = 0; n < 50; n++) await list.change((draft) => draft.items.push(String(n)), live.context);
			const committed = reads.mock.calls.length;
			await host.root(async (ctx) => {
				void list.change(() => {}, ctx).catch(() => {});
			}, context);
			await delivered();
			// The one cancelled change read its context once to be reported; the 50 committed ones never did.
			expect([committed, reads.mock.calls.length - committed, errors.length]).toEqual([0, 1, 1]);
		} finally {
			reads.mockRestore();
		}
		await host.close(context);
	});
});
