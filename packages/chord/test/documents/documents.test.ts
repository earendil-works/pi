import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withCancel, withTelemetry } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { ChordError } from "../../src/data/index.ts";
import type { Tx } from "../../src/documents/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../src/documents/index.ts";
import { createHost, defineFacet, type FollowObserver, type HostError } from "../../src/host/index.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { eq } from "../../src/store/expression.ts";
import type { TableOf } from "../../src/store/index.ts";
import { defineTable } from "../../src/store/table.ts";
import { delivered, framesOf, loaded, memoryStore, rejection, until } from "../support.ts";

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

describe("transactions their own object's end cancelled (ERNDL-1190)", () => {
	const Caller = local("app.caller", { version: 1, params: { id: int() }, members: { touch: method() } });
	const Echo = defineJob("app.echo", { version: 1, args: obj({ text: str() }), result: str() });

	/**
	 * A host serving `Owner`, whose attempts each run one transaction under the context they get there: in `self.open`
	 * (`open`, while the attempt activates; `open-fail`: the open then throws), `self.onLive` (`onLive`), a job run it
	 * starts once live (`job`), or its method `touch` (`method`; `Caller`'s `onLive` calls it with its routine's
	 * context). The transaction waits for `release` before it drafts. `started` resolves once it holds the line,
	 * `aborted` once its context aborted; `outcomes` gets how each ended; `facet()` is new code for the plugin (a reload
	 * restarts its objects).
	 */
	async function gated(where: "open" | "open-fail" | "onLive" | "job" | "method") {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const outcomes: unknown[] = [];
		const facet = () =>
			defineFacet((h) => {
				h.serve(Owner, (_, self) => {
					const list = self.state(List);
					const run = async (ctx: Context): Promise<void> => {
						await self
							.tx(async (tx) => {
								ctx.abortSignal?.addEventListener("abort", () => aborted.resolve());
								started.resolve();
								await gate.promise;
								(await tx.draft(list)).items.push("lost");
							}, ctx)
							.then(
								() => outcomes.push("committed"),
								(error: unknown) => outcomes.push(error),
							);
					};
					const job = self.job(Echo, {
						run: async ({ text }, ctx) => {
							await run(ctx);
							return text;
						},
					});
					if (where === "open") self.open(run, () => {});
					if (where === "open-fail") {
						self.open(
							async (ctx) => {
								void run(ctx);
								await started.promise;
								throw new Error("open failed");
							},
							() => {},
						);
					}
					if (where === "onLive") self.onLive(run);
					if (where === "job") self.onLive(async (ctx) => void job.start({ text: "a" }, ctx).catch(() => {}));
					const touch = async (ctx: Context): Promise<null> => {
						await run(ctx);
						return null;
					};
					return { list, touch };
				});
				h.serve(Caller, (_, self) => {
					const owner = self.get(Owner, { id: 1 });
					self.onLive(async (ctx) => void owner.touch(ctx).catch(() => {}));
					return { touch: async () => null };
				});
			});
		const errors: HostError[] = [];
		const host = createHost({ onError: (error) => errors.push(error), closeTimeout: 1000 });
		await host.load([{ name: "@test/app", facet: facet() }], context);
		const cancelled = () => errors.filter(({ kind }) => kind === "transaction_cancelled");
		return {
			host,
			errors,
			cancelled,
			outcomes,
			facet,
			started: started.promise,
			aborted: aborted.promise,
			release: () => gate.resolve(),
		};
	}

	describe("not reported: the object's own end", () => {
		it("an onLive transaction when the object ends: it rejects, nothing reaches onError", async () => {
			const { host, errors, outcomes, started, release } = await gated("onLive");
			const reference = await host.get(Owner, { id: 1 }, context);
			await started;
			reference.release();
			release();
			await until(() => outcomes.length === 1);
			expect(outcomes[0]).toMatchObject({ code: "released", reason: "discarded" });
			expect(errors).toEqual([]);
			await host.close(context);
		});

		it("an onLive transaction when a reload stops the routine while the old attempt drains", async () => {
			const { host, errors, outcomes, facet, started, aborted, release } = await gated("onLive");
			const reference = await host.get(Owner, { id: 1 }, context);
			await started;
			const reloaded = host.reload([{ name: "@test/app", facet: facet() }], context);
			await aborted;
			release();
			await reloaded;
			await until(() => outcomes.length >= 1);
			expect(outcomes[0]).toMatchObject({ message: "app.owner(1): reloaded" });
			expect(errors).toEqual([]);
			reference.release();
			await host.close(context);
		});

		it("an open's transaction when a reload replaces the activating attempt", async () => {
			const { host, errors, outcomes, facet, started, aborted, release } = await gated("open");
			const reference = host.hold(Owner, { id: 1 }, context);
			await started;
			const reloaded = host.reload([{ name: "@test/app", facet: facet() }], context);
			await aborted;
			release();
			await reloaded;
			await until(() => outcomes.length >= 1);
			expect(outcomes[0]).toMatchObject({ code: "released" });
			expect(errors).toEqual([]);
			reference.release();
			await host.close(context);
		});

		it("an open's transaction when the activation fails", async () => {
			const { host, cancelled, outcomes, aborted, release } = await gated("open-fail");
			const reference = host.hold(Owner, { id: 1 }, context);
			await aborted;
			release();
			await until(() => outcomes.length >= 1);
			expect(cancelled()).toEqual([]);
			reference.release();
			await host.close(context);
		});

		it("a job run's transaction when a reload cuts the run, and when the host closes", async () => {
			for (const end of ["reload", "close"] as const) {
				const { host, cancelled, outcomes, facet, started, aborted, release } = await gated("job");
				await host.get(Owner, { id: 1 }, context);
				await started;
				// A running job run keeps its object: the close ends it.
				const ending =
					end === "reload" ? host.reload([{ name: "@test/app", facet: facet() }], context) : host.close(context);
				await aborted;
				release();
				await ending;
				await until(() => outcomes.length >= 1);
				expect([end, cancelled()]).toEqual([end, []]);
				if (end === "reload") await host.close(context);
			}
		});

		it("a method's transaction when its object ends under the call (the host closes)", async () => {
			const { host, cancelled, outcomes, started, aborted, release } = await gated("method");
			const reference = await host.get(Owner, { id: 1 }, context);
			const call = reference.touch(context).catch(() => {});
			await started;
			const closed = host.close(context);
			await aborted;
			release();
			await Promise.all([closed, call]);
			await until(() => outcomes.length >= 1);
			expect(cancelled()).toEqual([]);
		});
	});

	describe("still reported: an end that is not its own object's", () => {
		it("a method's transaction its caller cancels, also with the reason a reload stopped a routine with", async () => {
			for (const reuse of [true, false]) {
				const { host, cancelled, outcomes, started, release } = await gated("method");
				const reference = await host.get(Owner, { id: 1 }, context);
				const caller = withCancel(context);
				const call = reference.touch(caller.context).catch((error: unknown) => error);
				await started;
				// The same reason object as the object's own end would carry must not hide the caller's cancel (Astra).
				const reason = reuse ? new Error("app.owner(1): reloaded") : new Error("cancelled");
				caller.cancel(reason);
				release();
				expect(await call).toBe(reason);
				await until(() => outcomes.length >= 1);
				expect(cancelled()).toEqual([{ kind: "transaction_cancelled", object: "app.owner(1)", error: reason }]);
				await host.close(context);
			}
		});

		it("a method's transaction when the calling object ends (a caller's cancel on the callee)", async () => {
			const { host, cancelled, outcomes, started, aborted, release } = await gated("method");
			const owner = await host.get(Owner, { id: 1 }, context);
			const caller = await host.get(Caller, { id: 1 }, context);
			await started;
			caller.release();
			await aborted;
			release();
			await until(() => outcomes.length >= 1);
			expect(cancelled()).toEqual([
				{
					kind: "transaction_cancelled",
					object: "app.owner(1)",
					error: expect.objectContaining({ message: "app.caller(1): ended" }),
				},
			]);
			owner.release();
			await host.close(context);
		});

		it("a transaction failing with its own error before its object ends: reported, not taken for the end", async () => {
			const entered = Promise.withResolvers<void>();
			const callback = Promise.withResolvers<void>();
			const done = Promise.withResolvers<void>();
			const { host, errors } = await loaded((h) =>
				h.serve(Owner, (_, self) => {
					const list = self.state(List);
					self.onLive(async (ctx) => {
						try {
							await self.tx(() => {
								entered.resolve();
								return callback.promise;
							}, ctx);
						} finally {
							done.resolve();
						}
					});
					return { list, touch: async () => null };
				}),
			);
			const reference = await host.get(Owner, { id: 1 }, context);
			await entered.promise;
			// Rejected first, then the release, before the transaction sees the rejection (Astra).
			callback.reject(new TypeError("malformed input"));
			reference.release();
			await done.promise;
			await host.close(context);
			// The callback's own failure is no cancellation: reported as before; the routine that ended with its object is
			// not (routines.test.ts: "a call that throws as it ends is not reported").
			expect(errors.map(({ kind }) => kind)).toEqual(["transaction_cancelled"]);
		});

		it("a callee's transaction when one runtime failure ends its caller first, then the callee", async () => {
			const Node = local("app.node", {
				version: 1,
				params: { id: int() },
				members: { call: method(), attached: str() },
			});
			for (const first of [0, 1]) {
				const entered = Promise.withResolvers<void>();
				const done = Promise.withResolvers<unknown>();
				const observers: FollowObserver<string>[] = [];
				const { host, errors } = await loaded((h) =>
					h.serve(Node, ({ id }, self) => ({
						attached: self.follow(async (to: FollowObserver<string>) => {
							observers[id] = to;
							return { value: "ready", detach() {} };
						}),
						call: async (ctx) => {
							if (id === 0) return (await ctx.get(Node, { id: 1 })).call(ctx);
							await self
								.tx(
									() =>
										new Promise<never>((_, reject) => {
											ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), {
												once: true,
											});
											entered.resolve();
										}),
									ctx,
								)
								.catch(done.resolve);
							return null;
						},
					})),
				);
				await host.get(Node, { id: 0 }, context);
				await host.get(Node, { id: 1 }, context);
				// One error both objects' runtime reports, the caller (0) or the callee (1) told first (Astra).
				const error = new ChordError({ code: "unavailable", message: "shared runtime died" });
				const call = host
					.get(Node, { id: 0 }, context)
					.then((outer) => outer.call(context))
					.catch(() => {});
				await entered.promise;
				observers[first]!.end({ kind: "failed", error });
				observers[1 - first]!.end({ kind: "failed", error });
				expect(await done.promise).toBe(error);
				await call;
				const cancelled = errors.filter(({ kind }) => kind === "transaction_cancelled");
				expect([first, cancelled.map((each) => (each as { object: string }).object)]).toEqual([
					first,
					first === 0 ? ["app.node(1)"] : [],
				]);
				await host.close(context);
			}
		});
	});
});

describe("commits in telemetry (slice 9)", () => {
	it("records a commit's documents, ops and duration as an event of its context's span, and its duration metric", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let list: SingletonHandle<{ items: string[] }> | undefined;
		const { host } = await loaded(
			(h) =>
				h.serve(Owner, (_, self) => {
					list = self.state(List);
					return { list, touch: async () => null };
				}),
			{ telemetry },
		);
		await host.get(Owner, { id: 1 }, context);
		await telemetry.startSpan({ name: "work" }, async (span) => {
			const traced = withTelemetry(span, context);
			await list!.change((draft) => {
				draft.items.push("a", "b");
			}, traced);
			// A transaction that changes nothing commits nothing: no event.
			await list!.change(() => {}, traced);
		});
		const work = telemetry.getSpans().find(({ name }) => name === "work");
		expect(work!.events).toEqual([
			{ name: "chord.commit", attributes: { documents: 1, ops: 1, rows: 0, duration: expect.any(Number) } },
		]);
		expect(telemetry.getMetrics().map(({ name, unit }) => [name, unit])).toContainEqual([
			"chord.commit.duration",
			"ms",
		]);
	});

	it("counts the table rows a commit's writes changed: a put one, an update or delete the rows it changed", async () => {
		const Rows = defineTable("rows", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
		// A table's owner has empty params.
		const Keeper = local("app.keeper", { version: 1, params: {}, members: { touch: method() } });
		const telemetry = new InMemoryTelemetryContext();
		let write: ((fn: (tx: Tx, rows: TableOf<typeof Rows>) => void, ctx: Context) => Promise<void>) | undefined;
		const { host } = await loaded(
			(h) =>
				h.serve(Keeper, (_, self) => {
					const rows = self.table(Rows);
					write = (fn, ctx) => self.tx((tx) => fn(tx, rows), ctx);
					return { touch: async () => null };
				}),
			{ telemetry, store: await memoryStore() },
		);
		await telemetry.startSpan({ name: "work" }, async (span) => {
			const traced = withTelemetry(span, context);
			await write!((tx, rows) => {
				for (const id of [1, 2, 3]) tx.put(rows, { id, text: "a" });
			}, traced);
			await write!((tx, rows) => {
				tx.updateWhere(rows, (row) => eq(row.text, "a"), { text: "b" });
				tx.delete(rows, { id: 9 });
			}, traced);
		});
		const work = telemetry.getSpans().find(({ name }) => name === "work");
		expect(work!.events.map(({ attributes }) => [attributes.documents, attributes.ops, attributes.rows])).toEqual([
			[0, 0, 3],
			[0, 0, 3],
		]);
		await host.close(context);
	});

	it("times nothing when nothing records", async () => {
		const { list } = await owner();
		const now = vi.spyOn(performance, "now");
		await list.change((draft) => void draft.items.push("a"), context);
		expect(now).not.toHaveBeenCalled();
		now.mockRestore();
	});
});
