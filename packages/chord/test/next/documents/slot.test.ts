// Singleton slots (slice 6a §4, §10, §11): retirement, slots kept across attempts, persisted singletons loaded once.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, obj, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import {
	defineState,
	type JsonObject,
	type KeyedHandle,
	type SingletonHandle,
} from "../../../src/next/documents/index.ts";
import type { HostError, StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import {
	changesOf,
	delivered,
	instancesOf,
	loaded,
	memoryStore,
	rejection,
	restartable,
	StoreRestartable,
	storeRestartable,
	valuesOf,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const ListV1 = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });

describe("retirement", () => {
	it("reaches watches as initial() with retired: true", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		await restartable(objects, (_, self) => {
			list = self.state(ListV1);
		});
		const initial = list!.value;
		const changes = changesOf(await list!.watch(context));
		await list!.change((draft) => void draft.items.push("a"), context);
		await list!.retire(context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { items: ["a"] }, ops: [["p", ["items"], 0, 0, ["a"]]], retired: false },
			{ kind: "value", value: initial, ops: [["r", initial]], retired: true },
		]);
	});

	it("a retire and a recreate of a present document in one transaction: one frame, retired, the new value", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		const { attempts } = await restartable(objects, (_, self) => {
			list = self.state(ListV1);
		});
		await list!.change((draft) => void draft.items.push("a"), context);
		const changes = changesOf(await list!.watch(context));
		await attempts[0]!.tx(async (tx) => {
			await tx.retire(list!);
			(await tx.draft(list!)).items.push("b");
		}, context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { items: ["b"] }, ops: [["r", { items: ["b"] }]], retired: true },
		]);
	});
});

describe("across attempts", () => {
	it("keep in-memory documents across a failure and retry; initial() is taken once", async () => {
		let initials = 0;
		const List = defineState("list", {
			schema: obj({ items: arr(str()) }),
			version: 1,
			initial: () => {
				initials++;
				return { items: [] };
			},
		});
		const handles: SingletonHandle<{ items: string[] }>[] = [];
		const { restart } = await restartable(objects, (_, self) => {
			handles.push(self.state(List));
		});
		const changes = changesOf(await handles[0]!.watch(context));
		await handles[0]!.change((draft) => void draft.items.push("a"), context);
		await restart();
		expect(handles[1]!.value).toEqual({ items: ["a"] });
		await handles[1]!.change((draft) => void draft.items.push("b"), context);
		await delivered();
		// The watch taken through the first attempt's handle follows the slot across attempts.
		expect(valuesOf(changes)).toEqual([{ items: ["a"] }, { items: ["a", "b"] }]);
		expect(initials).toBe(1);
	});

	it("drop the in-memory documents a later factory no longer declares: their watches end", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		const { restart } = await restartable(objects, (attempt, self) => {
			if (attempt === 1) list = self.state(ListV1);
		});
		await list!.change((draft) => void draft.items.push("a"), context);
		const watch = await list!.watch(context);
		await restart();
		expect(await watch.closed).toEqual({ kind: "ended" });
	});

	it("keep them across a throwing factory: only a factory that returns drops what it does not declare", async () => {
		const handles: SingletonHandle<{ items: string[] }>[] = [];
		const { fail, retry, errors } = await restartable(objects, (attempt, self) => {
			if (attempt === 2) throw new Error("factory threw");
			if (attempt !== 2) handles.push(self.state(ListV1));
		});
		await handles[0]!.change((draft) => void draft.items.push("a"), context);
		fail();
		await rejection(retry());
		expect(failure(errors)).toBe("app.restartable(1): factory threw");
		await retry();
		expect(handles[1]!.value).toEqual({ items: ["a"] });
	});

	it("migrate in memory when a later attempt declares a newer version; the old handles are refused", async () => {
		let initials = 0;
		const ListV2 = defineState("list", {
			schema: obj({ entries: arr(obj({ text: str() })) }),
			version: 2,
			initial: () => {
				initials++;
				return { entries: [] };
			},
			migrate: (old) => ({ entries: (old.items as string[]).map((text) => ({ text })) }),
		});
		const Notes1 = defineState("notes", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			keyed: true,
		});
		const Notes2 = defineState("notes", {
			schema: obj({ n: int(), m: int() }),
			version: 2,
			initial: () => ({ n: 0, m: 0 }),
			keyed: true,
			migrate: (old) => ({ n: old.n as number, m: 1 }),
		});
		const lists: SingletonHandle<JsonObject>[] = [];
		const notes: KeyedHandle<JsonObject>[] = [];
		const inFactory: unknown[] = [];
		const { restart } = await restartable(objects, (attempt, self) => {
			lists.push(self.state(attempt === 1 ? ListV1 : ListV2) as unknown as SingletonHandle<JsonObject>);
			notes.push(self.state(attempt === 1 ? Notes1 : Notes2) as unknown as KeyedHandle<JsonObject>);
			// The new code's handle in its own factory: the values are still at version 1 until the activation.
			if (attempt === 2) inFactory.push(rejectionOf(() => lists[1]!.value));
		});
		await lists[0]!.change((draft) => void (draft.items as string[]).push("a"), context);
		await notes[0]!.change(
			"k",
			(draft) => {
				draft.n = 5;
			},
			context,
		);
		const changes = changesOf(await lists[0]!.watch(context));
		await restart();
		expect(lists[1]!.value).toEqual({ entries: [{ text: "a" }] });
		expect(await notes[1]!.get("k", context)).toEqual({ n: 5, m: 1 });
		const stale = "list: a handle of version 1; the documents are at version 2";
		expect(() => lists[0]!.value).toThrow(stale);
		expect(await rejection(notes[0]!.get("k", context))).toMatchObject({ code: "released" });
		await delivered();
		expect(changes).toEqual([
			{
				kind: "value",
				value: { entries: [{ text: "a" }] },
				ops: [["r", { entries: [{ text: "a" }] }]],
				retired: false,
			},
		]);
		expect(initials).toBe(1);
		expect(inFactory).toEqual([expect.objectContaining({ code: "not_ready" })]);
	});

	it("fail the attempt broken for a flipped keyed, an older version or a schema changed without a bump", async () => {
		const KeyedList = defineState("list", {
			schema: obj({ items: arr(str()) }),
			version: 1,
			initial: () => ({ items: [] }),
			keyed: true,
		});
		const Changed = defineState("list", {
			schema: obj({ items: arr(int()) }),
			version: 1,
			initial: () => ({ items: [] }),
		});
		const Newer = defineState("list", {
			schema: obj({ items: arr(str()) }),
			version: 2,
			initial: () => ({ items: [] }),
			migrate: (old) => old as { items: string[] },
		});
		const cases = [
			[ListV1, KeyedList, "list: declared keyed, its documents are not"],
			[ListV1, Changed, "list: the schema changed without a version bump (version 1)"],
			[Newer, ListV1, "list: version 1 is older than its documents' (2)"],
		] as const;
		for (const [first, later, message] of cases) {
			const { fail, retry, errors } = await restartable(objects, (attempt, self) => {
				self.state(attempt === 1 ? first : later);
			});
			fail();
			await rejection(retry());
			expect(errors.map(({ kind }) => kind)).toEqual(["object_failed", "activation_failed"]);
			expect(failure(errors)).toBe(`app.restartable(1): ${message}`);
		}
	});
});

describe("persisted singletons", () => {
	const Prefs = defineState("prefs", {
		schema: obj({ theme: str(), n: int() }),
		version: 1,
		initial: () => ({ theme: "light", n: 0 }),
		persist: true,
		checkpointWhen: () => false,
	});

	/** A store host declaring `definition` per attempt; `prefs()` is the latest attempt's handle. */
	async function prefsIn(store: ChordStore, definition: typeof Prefs = Prefs) {
		let prefs: SingletonHandle<{ theme: string; n: number }> | undefined;
		const restartable = await storeRestartable(
			objects,
			(_, self) => {
				prefs = self.state(definition);
			},
			{ store },
		);
		return { ...restartable, prefs: () => prefs! };
	}

	/** The kinds of the outbox's writes, per commit. */
	async function outboxKinds(store: ChordStore): Promise<string[][]> {
		const commits = await store.outbox!.read(0, 100, context);
		return commits.map(({ writes }) =>
			writes.map((write) => (write.kind === "document.change" ? `change:${write.content.kind}` : write.kind)),
		);
	}

	it("load once per object at activation (not again on a retry), and survive the host", async () => {
		const store = await memoryStore({ outbox: true });
		const first = await prefsIn(store);
		expect(first.prefs().value).toEqual({ theme: "light", n: 0 });
		await first.prefs().change((draft) => {
			draft.theme = "dark";
		}, context);
		await first.prefs().change((draft) => {
			draft.n = 1;
		}, context);
		await first.host.close(context);
		const read = vi.spyOn(store, "read");
		const second = await prefsIn(store);
		expect(second.prefs().value).toEqual({ theme: "dark", n: 1 });
		expect(read).toHaveBeenCalledTimes(1);
		await second.restart();
		expect(second.prefs().value).toEqual({ theme: "dark", n: 1 });
		expect(read).toHaveBeenCalledTimes(1);
		await second.prefs().retire(context);
		expect(second.prefs().value).toEqual({ theme: "light", n: 0 });
		expect(await outboxKinds(store)).toEqual([["document.create"], ["change:delta"], ["document.retire"]]);
		await second.host.close(context);
		await store.close(context);
	});

	it("migrate a stored older version at load; the next change writes the migrated base back", async () => {
		const store = await memoryStore({ outbox: true });
		const old = await prefsIn(store);
		await old.prefs().change((draft) => {
			draft.n = 1;
		}, context);
		await old.host.close(context);
		const V2 = defineState("prefs", {
			schema: obj({ theme: str(), n: int() }),
			version: 2,
			initial: () => ({ theme: "light", n: 0 }),
			migrate: (value) => ({ theme: "migrated", n: Number(value.n) }),
			persist: true,
			checkpointWhen: () => false,
		});
		const { host, prefs } = await prefsIn(store, V2 as unknown as typeof Prefs);
		expect(prefs().value).toEqual({ theme: "migrated", n: 1 });
		await prefs().change((draft) => {
			draft.n = 2;
		}, context);
		expect((await outboxKinds(store)).at(-1)).toEqual(["change:base"]);
		await host.close(context);
		await store.close(context);
	});

	it("fail the activation broken for a newer stored version or another fingerprint at the same version (D9)", async () => {
		const store = await memoryStore();
		const V2 = defineState("prefs", {
			schema: obj({ theme: str(), n: int() }),
			version: 2,
			initial: () => ({ theme: "light", n: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		const Edited = defineState("prefs", {
			schema: obj({ theme: str() }),
			version: 2,
			initial: () => ({ theme: "light" }),
			persist: true,
			checkpointWhen: () => false,
		});
		const writer = await prefsIn(store, V2 as unknown as typeof Prefs);
		await writer.prefs().change((draft) => {
			draft.n = 1;
		}, context);
		await writer.host.close(context);
		for (const [definition, message] of [
			[Prefs, "prefs: stored at version 2, newer than the code's 1"],
			[Edited, "prefs: stored with another schema at version 2 (a schema changed without a bump)"],
		] as const) {
			const { host, errors } = await loaded(
				(h) =>
					h.serve(StoreRestartable, (_, self) => {
						self.state(definition);
						return { touch: async () => null };
					}),
				{ store },
			);
			await rejection(host.get(StoreRestartable, {}, context));
			expect(failure(errors)).toBe(`app.store: ${message}`);
			await host.close(context);
		}
		await store.close(context);
	});

	it("refuse persisting without a stable identity or a store, and a flipped persist", async () => {
		const InMemory = defineState("prefs", {
			schema: obj({ theme: str(), n: int() }),
			version: 1,
			initial: () => ({ theme: "light", n: 0 }),
		});
		const keyed = await restartable(objects, (_, self) => {
			// The types refuse it; a plugin may still try (P3).
			(self as StoreSelf).state(Prefs);
		}).catch((error: unknown) => error);
		expect(String(keyed)).toContain("persist needs a stable identity");
		const storeless = await storeRestartable(objects, (_, self) => void self.state(Prefs)).catch((error) => error);
		expect(String(storeless)).toContain("persist needs a store");
		const store = await memoryStore();
		const { fail, retry, errors } = await storeRestartable(
			objects,
			(attempt, self) => void self.state(attempt === 1 ? Prefs : InMemory),
			{ store },
		);
		fail();
		await rejection(retry());
		expect(failure(errors)).toBe("app.store: prefs: declared in memory, its documents are not");
		await store.close(context);
	});
});

/** The message of the last reported activation failure's error. */
function failure(errors: readonly HostError[]): string | undefined {
	const last = errors.findLast((error) => error.kind === "activation_failed");
	return last?.kind === "activation_failed" ? last.failure.error.message : undefined;
}

/** What `read` throws, as ChordError JSON when it is one. */
function rejectionOf(read: () => unknown): unknown {
	try {
		read();
	} catch (error) {
		return isChordError(error) ? error.toJSON() : error;
	}
	return undefined;
}
