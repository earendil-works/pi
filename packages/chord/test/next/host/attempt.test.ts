import { createHook } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, opt, remote, str } from "../../../src/next/contracts/index.ts";
import { broken, ChordError, isChordError } from "../../../src/next/data/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import {
	createHost,
	defineFacet,
	type HostError,
	type Reference,
	type Self,
	type StoreSelf,
} from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { TableHandle } from "../../../src/next/store/table-handle.ts";
import { prepareTables } from "../../../src/next/store/table-migration.ts";
import {
	failLive,
	failures,
	fakeTimers,
	flushed,
	instancesOf,
	loaded,
	memoryStore,
	metered,
	rejection,
	Server,
	tableOwner,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const List = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });
const Page = local("app.page", { version: 1, params: { id: int() }, members: { label: str(), slow: method() } });

describe("failure kinds", () => {
	const Broken = local("app.broken", { version: 1, params: { id: int() }, members: { label: str() } });
	const Bad = defineState("bad", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: "x" }) as never });

	it.each<[string, (self: Self) => unknown, string]>([
		[
			"a throwing factory",
			() => {
				throw new Error("factory threw");
			},
			"app.broken(1): factory threw",
		],
		["a missing member", () => ({}), "app.broken(1): label: a state member is a JSON watchable"],
		["an unknown member", () => ({ label: constant(""), extra: 1 }), "app.broken(1): extra: not a member"],
		[
			"a native watchable as state (Q14)",
			() => ({ label: { value: "x", watch: async () => ({}) } }),
			"app.broken(1): label: a state member is a JSON watchable",
		],
		[
			"a throwing first derive",
			(self) => ({
				label: self.derive([], () => {
					throw new Error("derive threw");
				}),
			}),
			"app.broken(1): derive threw",
		],
		[
			"an initial() that fails its schema",
			(self) => ({ label: self.derive([self.state(Bad)], () => "") }),
			"app.broken(1): bad: initial() does not match the schema",
		],
		[
			"an open that throws broken(error)",
			(self) => {
				self.open(
					async () => {
						throw broken(new Error("no remote configured"));
					},
					() => {},
				);
				return { label: constant("") };
			},
			"app.broken(1): no remote configured",
		],
	])(
		"%s fails broken: reported, the get rejects at once with a ChordError, nothing is left",
		async (_, factory, message) => {
			const served = vi.fn((_: { id: number }, self: Self) => factory(self) as never);
			const { host, errors } = await loaded((h) => h.serve(Broken, served));
			const error = await host.get(Broken, { id: 1 }, context).catch((error: unknown) => error);
			expect(isChordError(error) && error.message).toBe(message);
			await expect(host.get(Broken, { id: 1 }, context)).rejects.toThrow(message);
			expect(served).toHaveBeenCalledTimes(2);
			expect(failures(errors)).toEqual(["app.broken(1): broken", "app.broken(1): broken"]);
			// One report per failure: a derive throwing while its attempt activates reports no derive_failed.
			expect(errors.map(({ kind }) => kind)).toEqual(["activation_failed", "activation_failed"]);
		},
	);

	it("an open that throws fails transient: reported, the get waits through retries", async () => {
		const { host, errors } = await loaded((h) =>
			h.serve(Broken, (_, self) => {
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				return { label: constant("") };
			}),
		);
		expect(await rejection(host.get(Broken, { id: 1 }, context, { readyTimeout: 10 }))).toEqual({
			code: "unavailable",
			message: "app.broken(1): offline",
		});
		expect(errors).toMatchObject([
			{
				kind: "activation_failed",
				object: "app.broken(1)",
				failure: { kind: "transient", error: { code: "unavailable" } },
			},
		]);
		await host.close(context);
	});

	describe("an attempt not live within readyTimeout", () => {
		fakeTimers();

		it("is abandoned and fails transient: the opener's context aborted, what opened closed", async () => {
			let opener: Context | undefined;
			const closes: string[] = [];
			const { host, errors } = await loaded(
				(h) =>
					h.serve(Broken, (_, self) => {
						self.open(
							async () => "a",
							(value, reason) => void closes.push(`${value} ${reason.kind}`),
						);
						self.open(
							async (ctx) => {
								opener = ctx;
								return new Promise<string>(() => {});
							},
							() => {},
						);
						return { label: constant("") };
					}),
				{ readyTimeout: 100 },
			);
			const got = rejection(host.get(Broken, { id: 1 }, context, { readyTimeout: 150 }));
			await vi.advanceTimersByTimeAsync(100);
			expect([opener?.abortSignal?.aborted, closes]).toEqual([true, ["a end"]]);
			const notLive = { code: "unavailable", message: "app.broken(1): did not become live within 100 ms" };
			expect(errors).toMatchObject([{ kind: "activation_failed", failure: { kind: "transient", error: notLive } }]);
			await vi.advanceTimersByTimeAsync(50);
			expect(await got).toEqual(notLive);
		});
	});

	describe("an attempt waiting for its previous instance's teardown", () => {
		fakeTimers();

		it("is bounded by readyTimeout too: abandoned transient without running its factory, retried after it", async () => {
			const closing = Promise.withResolvers<void>();
			let factories = 0;
			const { host, errors } = await loaded(
				(h) =>
					h.serve(Page, (_, self) => {
						factories++;
						self.open(
							async () => "native",
							() => closing.promise,
						);
						return { label: constant("p"), slow: async () => null };
					}),
				{ readyTimeout: 100, closeTimeout: 10_000 },
			);
			(await host.get(Page, { id: 1 }, context)).release();
			const next = host.hold(Page, { id: 1 }, context);
			await vi.advanceTimersByTimeAsync(100);
			expect(factories).toBe(1);
			expect(errors).toMatchObject([
				{
					kind: "activation_failed",
					failure: { kind: "transient", error: { message: "app.page(1): did not become live within 100 ms" } },
				},
			]);
			closing.resolve();
			await vi.advanceTimersByTimeAsync(1_000);
			expect([factories, next.state.value]).toEqual([2, { kind: "live" }]);
		});
	});

	it("a keyed document's initial() failing its schema fails that transaction, not the object", async () => {
		const Keys = defineState("keys", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: "x" }) as never,
			keyed: true,
		});
		const { host, errors } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				const keys = self.state(Keys);
				return {
					label: constant("live"),
					slow: async (ctx) => {
						await keys.change("a", () => {}, ctx);
						return null;
					},
				};
			}),
		);
		const page = await host.get(Page, { id: 1 }, context);
		await expect(page.slow(context)).rejects.toThrow("keys: initial() does not match the schema");
		expect([page.label.value, errors]).toEqual(["live", []]);
	});

	it("releases the references it acquired", async () => {
		const pages = vi.fn((_: { id: number }) => ({ label: constant("p"), slow: async () => null }));
		const { host } = await loaded((h) => {
			h.serve(Broken, (_, self) => {
				const page = self.get(Page, { id: 7 });
				const label = self.derive([page.label], (): string => {
					throw new Error("late");
				});
				return { label };
			});
			h.serve(Page, pages);
		});
		await expect(host.get(Broken, { id: 1 }, context)).rejects.toThrow("late");
		expect(pages).toHaveBeenCalledTimes(1);
		await host.get(Page, { id: 7 }, context);
		expect(pages).toHaveBeenCalledTimes(2);
	});
});

describe("ending", () => {
	it("rejects their callers at once; the handler runs on with its context aborted and cannot commit", async () => {
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<{ aborted?: boolean; error?: unknown }>();
		const { host } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				const list = self.state(List);
				return {
					label: constant(""),
					slow: async (ctx) => {
						started.resolve();
						await proceed.promise;
						const tx = self.tx(async (tx) => (await tx.draft(list)).items.push("x"), context);
						finished.resolve({ aborted: ctx.abortSignal?.aborted, error: await rejection(tx) });
						return null;
					},
				};
			}),
		);
		const page = await host.get(Page, { id: 1 }, context);
		const call = page.slow(context);
		await started.promise;
		page.release();
		const released = { code: "released", reason: "ended", message: "app.page(1): ended" };
		expect(await rejection(call)).toEqual(released);
		proceed.resolve();
		expect(await finished.promise).toEqual({ aborted: true, error: released });
	});

	it("rejects a call whose caller's context is already aborted, before the handler runs", async () => {
		const slow = vi.fn(async () => null);
		const { host } = await loaded((h) => h.serve(Page, () => ({ label: constant(""), slow })));
		const page = await host.get(Page, { id: 1 }, context);
		const { context: cancelled, cancel } = withCancel(context);
		cancel(new Error("gone"));
		await expect(page.slow(cancelled)).rejects.toThrow("gone");
		expect(slow).not.toHaveBeenCalled();
	});

	it("waits for the running handlers' own promises (the drain) before the natives close", async () => {
		const events: string[] = [];
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				self.open(
					async () => "native",
					(value, reason) => void events.push(`close ${value} ${reason.kind}`),
				);
				return {
					label: constant(""),
					slow: async () => {
						started.resolve();
						await proceed.promise;
						events.push("handler settled");
						return null;
					},
				};
			}),
		);
		const page = await host.get(Page, { id: 1 }, context);
		const call = page.slow(context);
		await started.promise;
		page.release();
		await expect(call).rejects.toThrow("app.page(1): ended");
		await flushed();
		expect(events).toEqual([]);
		proceed.resolve();
		await flushed();
		expect(events).toEqual(["handler settled", "close native end"]);
	});

	it("drains a handler that releases its object's last reference before it returns its promise", async () => {
		const events: string[] = [];
		const proceed = Promise.withResolvers<void>();
		let page: Reference<typeof Page> | undefined;
		const { host } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				self.open(
					async () => null,
					() => void events.push("closed"),
				);
				return {
					label: constant(""),
					// Not async: the release runs before the handler has a promise to return.
					slow: () => {
						page!.release();
						return proceed.promise.then(() => {
							events.push("handler settled");
							return null;
						});
					},
				};
			}),
		);
		page = await host.get(Page, { id: 1 }, context);
		const call = page.slow(context);
		await expect(call).rejects.toThrow("app.page(1): ended");
		await flushed();
		expect(events).toEqual([]);
		proceed.resolve();
		await flushed();
		expect(events).toEqual(["handler settled", "closed"]);
	});

	it("refuses transactions at once; documents stay readable until the closes are done", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		const seen = Promise.withResolvers<unknown[]>();
		const { host } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				const handle = self.state(List);
				list = handle;
				self.open(
					async () => null,
					async () => seen.resolve([handle.value, await rejection(handle.change(() => {}, context))]),
				);
				return { label: constant(""), slow: async () => null };
			}),
		);
		(await host.get(Page, { id: 1 }, context)).release();
		expect(await seen.promise).toEqual([
			{ items: [] },
			{ code: "released", reason: "ended", message: "app.page(1): ended" },
		]);
		await flushed();
		expect(() => list!.value).toThrow("app.page(1): ended");
	});

	describe("the drain", () => {
		fakeTimers();

		it("is bounded by closeTimeout: a handler still running then sees its natives close, which is reported", async () => {
			const closed = vi.fn();
			const { host, errors } = await loaded(
				(h) =>
					h.serve(Page, (_, self) => {
						self.open(async () => null, closed);
						return { label: constant(""), slow: () => new Promise<null>(() => {}) };
					}),
				{ closeTimeout: 1000 },
			);
			const page = await host.get(Page, { id: 1 }, context);
			void page.slow(context).catch(() => {});
			page.release();
			await vi.advanceTimersByTimeAsync(999);
			expect(closed).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(closed).toHaveBeenCalledTimes(1);
			expect(errors).toEqual([{ kind: "drain_timeout", object: "app.page(1)" }]);
		});

		it("a handler stuck past it no longer counts as a call nor holds its ctx.get references", async () => {
			const Item = local("app.item", { version: 1, params: { id: int() }, members: { label: str() } });
			const got = Promise.withResolvers<void>();
			const { host } = await loaded(
				(h) => {
					h.serve(Item, () => ({ label: constant("item") }));
					h.serve(Page, () => ({
						label: constant(""),
						slow: async (ctx) => {
							await ctx.get(Item, { id: 7 });
							got.resolve();
							return new Promise<null>(() => {});
						},
					}));
				},
				{ closeTimeout: 1000 },
			);
			const items = host.references(Item);
			const page = await host.get(Page, { id: 1 }, context);
			void page.slow(context).catch(() => {});
			await got.promise;
			expect(host.activity.value.calls).toBe(1);
			expect(items.value).toHaveLength(1);
			page.release();
			await vi.advanceTimersByTimeAsync(1000);
			expect(host.activity.value.calls).toBe(0);
			expect(items.value).toEqual([]);
		});
	});
});

describe("declarations", () => {
	it("are valid only while the factory runs", async () => {
		let later: Self | undefined;
		const { host } = await loaded((h) =>
			h.serve(Page, (_, self) => {
				later = self;
				return { label: constant(""), slow: async () => null };
			}),
		);
		await host.get(Page, { id: 1 }, context);
		expect(() => later!.state(List)).toThrow("app.page(1): self.state is valid only in the factory");
		expect(() => later!.derive([], () => 1)).toThrow("self.derive is valid only in the factory");
		expect(() => later!.get(Page, { id: 2 })).toThrow("self.get is valid only in the factory");
		expect(() =>
			later!.open(
				async () => null,
				() => {},
			),
		).toThrow("self.open is valid only in the factory");
		const Names = defineRegistry<string, number>("app.names", { version: 1 });
		expect(() => later!.registry(Names)).toThrow("self.registry is valid only in the factory");
		expect(() => later!.writable(1)).toThrow("self.writable is valid only in the factory");
		expect(() => later!.retryOn()).toThrow("self.retryOn is valid only in the factory");
	});

	it("contribute only in host-lifetime objects (R21): `Self` has no `contribute`, a declaration error at runtime", async () => {
		expectTypeOf<Self>().not.toHaveProperty("contribute");
		expectTypeOf<StoreSelf>().toHaveProperty("contribute");
		const Names = defineRegistry<string, number>("app.names", { version: 1 });
		const Store = local("app.store", { version: 1, params: {}, members: {} });
		const { host } = await loaded((h) => {
			h.serve(Names, { compose: (table) => table.length });
			h.serve(Page, (_, self) => {
				(self as unknown as StoreSelf).contribute(Names, "page");
				return { label: constant(""), slow: async () => null };
			});
			h.serve(Store, (_, self) => {
				self.contribute(Names, "a");
				self.contribute(Names, "b");
				return {};
			});
		});
		await expect(host.get(Page, { id: 1 }, context)).rejects.toThrow(
			"app.page(1): self.contribute is valid only in a local type with empty params",
		);
		await expect(host.get(Store, {}, context)).rejects.toThrow(
			"app.store: registry app.names is contributed to twice",
		);
		await host.close(context);
	});

	it("refuse a document definition declared twice", async () => {
		const Twice = local("app.twice", { version: 1, params: { n: int() }, members: {} });
		const { host } = await loaded((h) =>
			h.serve(Twice, (_, self) => {
				[self.state(List), self.state(List)];
				return {};
			}),
		);
		await expect(host.get(Twice, { n: 2 }, context)).rejects.toThrow('app.twice(2): state "list" is declared twice');
	});
});

describe("calls", () => {
	it("check arguments with L1 and pass arguments and results by reference", async () => {
		const seen: unknown[] = [];
		const result = { items: [] };
		const Echo = local("app.echo", {
			version: 1,
			params: {},
			members: { echo: method(obj({ text: str() }), obj({ items: arr(str()) })), none: method() },
		});
		const { host } = await loaded((h) =>
			h.serve(Echo, () => ({
				echo: async (args) => {
					seen.push(args);
					return result;
				},
				// A method without arguments gets only the context.
				none: async (...args) => {
					seen.push(args.length);
					return null;
				},
			})),
		);
		const echo = await host.get(Echo, {}, context);
		const args = { text: "t" };
		expect(await echo.echo(args, context)).toBe(result);
		expect(await echo.none(context)).toBeNull();
		expect(seen).toEqual([args, 1]);
		expect(seen[0]).toBe(args);
		// @ts-expect-error: an unknown field
		expect(await rejection(echo.echo({ text: "t", extra: 1 }, context))).toMatchObject({
			code: "invalid",
			reason: "args",
		});
	});

	it("take a plain value or a synchronous throw from a handler that is no async function", async () => {
		const Plain = local("app.plain", {
			version: 1,
			params: {},
			members: { value: method(undefined, int()), fail: method() },
		});
		const { host } = await loaded((h) =>
			// Plugin code is bundled without type checks.
			h.serve(Plain, () => ({
				value: (() => 7) as never,
				fail: (() => {
					throw new Error("sync throw");
				}) as never,
			})),
		);
		const plain = await host.get(Plain, {}, context);
		expect(await plain.value(context)).toBe(7);
		await expect(plain.fail(context)).rejects.toThrow("sync throw");
	});

	it("cost one validation per call and one compilation per method", async () => {
		const telemetry = await metered();
		// A fresh declaration: compiled checks are cached per contract.
		const Fresh = local("app.store", { version: 1, params: {}, members: { add: method(obj({ text: str() })) } });
		const { host } = await loaded((h) => h.serve(Fresh, () => ({ add: async () => null })));
		const store = await host.get(Fresh, {}, context);
		await store.add({ text: "a" }, telemetry.context);
		await store.add({ text: "b" }, telemetry.context);
		expect(telemetry.counts()).toEqual({ "chord.data.compilations": 1, "chord.data.validations": 2 });
	});
});

describe("the call path's cost", () => {
	it("makes at most 19 promises per local call (a guard: the drain and the cleanups share one reaction)", async () => {
		const Touch = local("app.touch", { version: 1, params: {}, members: { touch: method() } });
		const { host } = await loaded((h) => h.serve(Touch, () => ({ touch: async () => null })));
		const ref = await host.get(Touch, {}, context);
		await ref.touch(context);
		let promises = 0;
		// Every `then` makes a promise: one more reaction per call shows here (HEAD before the cleanups made 20).
		const hook = createHook({
			init: (_id, type) => {
				if (type === "PROMISE") promises++;
			},
		});
		hook.enable();
		try {
			for (let call = 0; call < 100; call++) await ref.touch(context);
		} finally {
			hook.disable();
		}
		expect(promises / 100).toBeLessThanOrEqual(19);
		await host.close(context);
	});
});

describe("remote variants", () => {
	const Two = remote("app.two", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { full: { state: { n: int() }, methods: { bump: method() } }, view: { state: { n: int() } } },
	});
	const owner = { kind: "owner" } as const;

	/** A host acting as `owner` whose factory for `Two` returns `implementation`. */
	async function two(implementation: unknown) {
		const errors: HostError[] = [];
		const host = createHost<typeof owner>({
			address: Server(),
			principal: owner,
			onError: (error) => errors.push(error),
		});
		const facet = defineFacet<typeof owner>((h) => h.serve(Two, () => implementation as never));
		await host.load([{ name: "@test/app", facet }], context);
		return { host, errors };
	}

	it("the factory chooses one; the reference narrows on its variant", async () => {
		const { host } = await two({ variant: "view", members: { n: constant(1) } });
		const ref = await host.get(Two, {}, context);
		expect(ref.variant).toBe("view");
		if (ref.variant === "view") expect(ref.n.value).toBe(1);
	});

	it.each([
		["an unknown variant", { variant: "other", members: {} }, 'variant "other": not a variant of app.two'],
		["a missing member", { variant: "full", members: { n: constant(1) } }, "bump: a method is a function"],
		[
			"an extra member",
			{ variant: "view", members: { n: constant(1), bump: async () => null } },
			"bump: not a member",
		],
	])("%s fails the activation broken", async (_, implementation, message) => {
		const { host, errors } = await two(implementation);
		expect(await rejection(host.get(Two, {}, context))).toEqual({
			code: "unavailable",
			message: `app.two: ${message}`,
		});
		expect(failures(errors)).toEqual(["app.two: broken"]);
	});

	it("a member outside the bound variant fails invalid/member", async () => {
		const { host } = await two({ variant: "view", members: { n: constant(1) } });
		const ref = (await host.get(Two, {}, context)) as unknown as { bump(ctx: Context): Promise<null> };
		expect(await rejection(ref.bump(context))).toEqual({
			code: "invalid",
			reason: "member",
			message: 'app.two (variant view) has no method "bump"',
		});
	});
});

describe("tables", () => {
	const Edits = defineTable("edits", {
		version: 1,
		columns: { id: str(), at: int() },
		key: ["id"],
		indexes: { by_at: ["at"] },
	});
	const Store = local("app.store", { version: 1, params: {}, members: { n: int() } });

	it("a fresh table is created at activation at its version, with its indexes, in one commit", async () => {
		const store = await memoryStore({ outbox: true });
		const { host } = await loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					self.table(Edits);
					return { n: constant(1) };
				}),
			{
				store,
			},
		);
		await host.get(Store, {}, context);
		expect(store.table("app.store:edits")).toMatchObject({
			version: 1,
			state: "ready",
			indexes: { by_at: ["at"] },
		});
		expect((await store.outbox!.read(0, 10, context)).map(({ writes }) => writes.map(({ kind }) => kind))).toEqual([
			["table", "index"],
		]);
		await host.close(context);
		const again = await loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					self.table(Edits);
					return { n: constant(1) };
				}),
			{
				store,
			},
		);
		await again.host.get(Store, {}, context);
		expect(store.lastSeq).toBe(1);
		await again.host.close(context);
		await store.close(context);
	});

	it.each<[string, (self: StoreSelf) => void, string]>([
		[
			"declared twice",
			(self) => {
				self.table(Edits);
				self.table(Edits);
			},
			'table "edits" is declared twice',
		],
		[
			"another version recorded",
			(self) => self.table(defineTable("edits", { version: 2, columns: { id: str() }, key: ["id"] })),
			"older than the history's base 2",
		],
		[
			"another definition at the same version",
			(self) => self.table(defineTable("edits", { version: 1, columns: { id: str(), at: int() }, key: ["id"] })),
			"recorded with another definition",
		],
	])("fails the activation broken: %s", async (_, declare, message) => {
		const store = await memoryStore();
		const first = await loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					self.table(Edits);
					return { n: constant(1) };
				}),
			{
				store,
			},
		);
		await first.host.get(Store, {}, context);
		await first.host.close(context);
		const { host } = await loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					declare(self);
					return { n: constant(1) };
				}),
			{ store },
		);
		expect(await rejection(host.get(Store, {}, context))).toMatchObject({
			message: expect.stringContaining(message),
		});
		await host.close(context);
		await store.close(context);
	});

	it("needs a local type with empty params (P3) and a host with a store", async () => {
		const { host } = await loaded((h) => {
			h.serve(Page, (_, self) => {
				// @ts-expect-error: only a local type with empty params has tables (P3)
				const declare = () => self.table(Edits);
				void declare;
				(self as unknown as StoreSelf).table(Edits);
				return { label: constant(""), slow: async () => null };
			});
			h.serve(Store, (_, self) => {
				self.table(Edits);
				return { n: constant(1) };
			});
		});
		expect(await rejection(host.get(Page, { id: 1 }, context))).toMatchObject({
			message: expect.stringContaining("persist needs a stable identity"),
		});
		expect(await rejection(host.get(Store, {}, context))).toMatchObject({
			message: expect.stringContaining("persist needs a store"),
		});
		await host.close(context);
	});
});

describe("eager migrations at activation (slice 6a §9)", () => {
	fakeTimers();
	// The clock is faked, but the zero-delay timers a migration yields with between chunks run every real turn.
	let pumping = true;
	beforeEach(() => {
		pumping = true;
		const pump = (): void => {
			if (!pumping) return;
			vi.advanceTimersByTime(0);
			setImmediate(pump);
		};
		setImmediate(pump);
	});
	afterEach(() => {
		pumping = false;
	});
	const TABLE = "app.store:edits";
	const OPEN = { admit: () => true, adopt: () => {} };
	const EditsV1 = defineTable("edits", { version: 1, columns: { id: str(), at: int() }, key: ["id"] });
	const Store = local("app.store", { version: 1, params: {}, members: { n: int() } });
	const Slow = local("app.slow", { version: 1, params: {}, members: { n: int() } });

	/** A store whose edits table is at version 1 with `count` rows. */
	async function seeded(count: number): Promise<ChordStore> {
		const store = await memoryStore();
		await prepareTables([{ definition: EditsV1, table: TABLE }], store, OPEN, "app.store", context);
		const staged: StagedWrite[] = [];
		const changes = new TableChanges(new TableHandle(EditsV1, TABLE, store, tableOwner()), staged);
		for (let i = 0; i < count; i++) changes.put({ id: `e${String(i).padStart(3, "0")}`, at: i });
		await store.commit(staged, OPEN, context);
		return store;
	}

	/** Waits (real turns of the event loop, the clock faked) until `done`. */
	async function until(done: () => boolean): Promise<void> {
		for (let turn = 0; turn < 1_000 && !done(); turn++) await flushed();
		expect(done()).toBe(true);
	}

	/** Version 2 adding `note`, whose `rows` runs `each` per row first. */
	function evolved(each: (id: string) => void) {
		return evolveTable(EditsV1, (t) =>
			t.add("note", opt(str())).rows((row) => {
				each(row.id);
				return { note: `#${row.at}` };
			}),
		);
	}

	/** A native whose open never succeeds: it rejects when its context is aborted (the deadline). */
	function hanging(ctx: Context): Promise<string> {
		return new Promise((_, reject) => ctx.abortSignal!.addEventListener("abort", () => reject(new Error("aborted"))));
	}

	it("pause the readyTimeout deadline and resume it with the budget left", async () => {
		const store = await seeded(250);
		// Each row takes 10 ms of the fake clock: 2.5 s of migration against a 1 s deadline.
		const Edits = evolved(() => vi.advanceTimersByTime(10));
		const loading = loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					self.table(Edits);
					// The factory takes 600 ms of the budget; the native after the migration never opens.
					vi.advanceTimersByTime(600);
					self.open(hanging, () => {});
					return { n: constant(1) };
				}),
			{ store, readyTimeout: 1_000 },
		);
		await until(() => store.table(TABLE)?.version === 2 && store.table(TABLE)?.state === "ready");
		expect(Date.now()).toBe(3_100);
		await vi.advanceTimersByTimeAsync(399);
		await vi.advanceTimersByTimeAsync(1);
		const { host, errors } = await loading;
		expect(Date.now()).toBe(3_500);
		expect(errors).toMatchObject([
			{
				kind: "activation_failed",
				failure: { kind: "transient", error: { message: "app.store: did not become live within 1000 ms" } },
			},
		]);
		await host.close(context);
		await store.close(context);
	});

	it("a timer firing during a long migration: another activation's deadline keeps its bound", async () => {
		const store = await seeded(250);
		const Edits = evolved(() => vi.advanceTimersByTime(10));
		// Both types have empty params: the host activates both at load, the start barrier waiting for both.
		const { host, errors } = await loaded(
			(h) => {
				h.serve(Slow, (_, self) => {
					self.open(hanging, () => {});
					return { n: constant(1) };
				});
				h.serve(Store, (_, self) => {
					self.table(Edits);
					return { n: constant(1) };
				});
			},
			{ store, readyTimeout: 1_000 },
		);
		expect(Date.now()).toBe(2_500);
		expect(errors).toMatchObject([{ kind: "activation_failed", object: "app.slow", failure: { kind: "transient" } }]);
		expect((await host.get(Store, {}, context)).n.value).toBe(1);
		await host.close(context);
		await store.close(context);
	});

	it("a throwing rows fails the object broken, the table migrating; a retry resumes after the committed chunks", async () => {
		const store = await seeded(250);
		let crash = true;
		const patched: string[] = [];
		const Edits = evolved((id) => {
			if (crash && id === "e150") throw new Error("crash");
			patched.push(id);
		});
		const { host, errors } = await loaded(
			(h) =>
				h.serve(Store, (_, self) => {
					self.table(Edits);
					return { n: constant(1) };
				}),
			{ store },
		);
		const held = host.hold(Store, {}, context);
		await until(() => held.state.value.kind === "failed");
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: { message: expect.stringContaining("crash") } },
		});
		expect(errors).toMatchObject([{ kind: "activation_failed", failure: { kind: "broken" } }]);
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "migrating" });
		crash = false;
		patched.length = 0;
		held.retry();
		await until(() => held.state.value.kind === "live");
		expect(patched).toHaveLength(150);
		expect(patched[0]).toBe("e100");
		expect(store.table(TABLE)).toMatchObject({ version: 2, state: "ready" });
		held.release();
		await host.close(context);
		await store.close(context);
	});
});

describe("parked attempts (dependency model §3)", () => {
	fakeTimers();
	const View = local("app.view", { version: 1, params: {}, members: { n: int() } });
	const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });
	/** A view with params: no host lifetime, so `load` does not wait for it. */
	const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: { n: int() } });

	it("run no timer while parked but parked_long's: no dependency deadline, no backoff, the factory run once", async () => {
		const factories = vi.fn();
		const { host, errors } = await loaded((h) =>
			h.serve(View, (_, self) => {
				factories();
				return { n: self.get(Missing, {}).n };
			}),
		);
		const view = host.hold(View, {}, context);
		await flushed();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.missing: app.missing is not served here" } },
			retryAt: undefined,
		});
		// `parked_long`'s one timer fired (once, after readyTimeout); nothing else runs.
		expect(vi.getTimerCount()).toBe(0);
		expect([factories.mock.calls.length, errors]).toEqual([
			1,
			[{ kind: "parked_long", object: "app.view", waitingFor: "app.missing", state: "failed", since: 0 }],
		]);
		view.release();
	});

	it("pause the readyTimeout deadline while parked: the own steps get the budget left", async () => {
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: { n: int() } });
		const { host, errors } = await loaded(
			(h) => {
				h.serve(Slow, (_, self) => {
					self.open(
						() => new Promise((resolve) => setTimeout(resolve, 5_000)),
						() => {},
					);
					return { n: constant(1) };
				});
				h.serve(Viewer, (_, self) => {
					const slow = self.get(Slow, { id: 1 });
					self.open(
						() => new Promise(() => {}),
						() => {},
					);
					return { n: slow.n };
				});
			},
			{ readyTimeout: 10_000 },
		);
		const view = host.hold(Viewer, { id: 1 }, context);
		// Parked 5 s on its dependency; then its own open hangs: it fails 10 s after the boundary, not 10 s after start.
		await vi.advanceTimersByTimeAsync(5_000 + 9_999);
		expect(failures(errors)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(failures(errors)).toEqual(["app.viewer(1): transient"]);
		view.release();
	});

	it("go on past the dependency check: a dependency leaving live during the own steps changes nothing (R18)", async () => {
		const Dependency = local("app.dependency", { version: 1, params: {}, members: { n: int() } });
		const gate = Promise.withResolvers<void>();
		let dependencySelf: Self | undefined;
		const { host, errors } = await loaded((h) => {
			h.serve(Dependency, (_, self) => {
				dependencySelf = self;
				return { n: constant(1) };
			});
			h.serve(Viewer, (_, self) => {
				const dependency = self.get(Dependency, {});
				self.open(
					() => gate.promise,
					() => {},
				);
				return { n: dependency.n };
			});
		});
		const view = host.hold(Viewer, { id: 1 }, context);
		await flushed();
		// The view opens its own native; its dependency fails live meanwhile.
		failLive(objects, dependencySelf!, new ChordError({ code: "unavailable", message: "offline" }));
		await flushed();
		gate.resolve();
		await flushed();
		expect(view.state.value).toEqual({ kind: "live" });
		expect(failures(errors)).toEqual([]);
		view.release();
	});
});
