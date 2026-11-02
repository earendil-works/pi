import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, createContextKey, withContextValue } from "../../../src/context/index.ts";
import { hostKind, int, method, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import {
	addNote,
	expectCollected,
	fakeTimers,
	flushed,
	forEachCodec,
	PlacedNotes,
	rejection,
	relayed,
	Server,
	Session,
	serveNotes,
	type TestPrincipal,
	transported,
} from "../support.ts";

/** Advances fake time by `ms`, then lets links and promises settle. */
async function elapse(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await transported();
}

forEachCodec(() => {
	describe("route admission", () => {
		it("runs one resolve per address, shared by the holds that wait for it (race 1)", async () => {
			const { tab, resolves, workers } = await relayed();
			const [one, two] = await Promise.all([
				tab.get(PlacedNotes, { session: "S1" }, context),
				tab.get(PlacedNotes, { session: "S1" }, context),
			]);
			expect(resolves).toEqual(["session|S1"]);
			await addNote(workers.get("session|S1")!, "S1", "a");
			await transported();
			expect(one.notes.value).toEqual([{ text: "a" }]);
			expect(two.notes.value).toEqual([{ text: "a" }]);
			await tab.get(PlacedNotes, { session: "S2" }, context);
			expect(resolves).toEqual(["session|S1", "session|S2"]);
		});

		it("authorizes every hold with its principal: a refusal is broken forbidden, other principals still resolve (race 4)", async () => {
			const authorize = (principal: TestPrincipal, address: { readonly key: string }) =>
				principal.kind === "owner" ||
				(principal.kind === "guest" && address.key === `session|${principal.session}`);
			const guest = await relayed({ tab: { kind: "guest", session: "S1" }, authorize });
			expect(await rejection(guest.tab.get(PlacedNotes, { session: "S2" }, context))).toEqual({
				code: "forbidden",
				message: "session|S2: not authorized",
			});
			expect(guest.resolves).toEqual([]);
			expect((await guest.tab.get(PlacedNotes, { session: "S1" }, context)).variant).toBe("reader");
			const owner = await relayed({ authorize });
			expect((await owner.tab.get(PlacedNotes, { session: "S2" }, context)).variant).toBe("editor");
		});

		it("ref.retry() holds a refused hold again: authorize admitting it later, over a link and on this host (audit)", async () => {
			let admit = false;
			const { tab, server } = await relayed({ authorize: () => admit });
			const overLink = tab.hold(PlacedNotes, { session: "S1" }, context);
			const here = server.hold(PlacedNotes, { session: "S2" }, context);
			await transported();
			for (const ref of [overLink, here]) {
				expect(ref.state.value).toMatchObject({
					kind: "failed",
					cause: { kind: "broken", error: { code: "forbidden" } },
				});
			}
			admit = true;
			overLink.retry();
			here.retry();
			await transported();
			expect(overLink.state.value).toEqual({ kind: "live" });
			expect(here.state.value).toEqual({ kind: "live" });
		});

		it("ref.retry() of a reference refused on this host after host.close ends it released, nothing resolved (audit)", async () => {
			let admit = false;
			const { server, resolves } = await relayed({ authorize: () => admit });
			const ref = server.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(ref.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "forbidden" } } });
			await server.close(context);
			admit = true;
			ref.retry();
			await transported();
			expect(ref.state.value).toMatchObject({ kind: "ended", error: { code: "released", reason: "closed" } });
			expect(resolves).toEqual([]);
		});

		it("fails a hold broken with what authorize throws", async () => {
			const { tab } = await relayed({
				authorize: () => {
					throw new Error("authorize threw");
				},
			});
			expect(await rejection(tab.get(PlacedNotes, { session: "S1" }, context))).toMatchObject({
				message: "app.placed-notes: authorize threw",
			});
		});

		it("fails a hold broken invalid/host_address for an address whose params do not fit the kind", async () => {
			const Misplaced = remote("app.misplaced", {
				version: 1,
				params: { n: int() },
				// An address of the right kind with params of the wrong type, as a buggy `hostAddress` could compute.
				hostAddress: ({ n }) => ({ kind: "session", params: { id: n }, key: "" }) as never,
				variants: { v: { state: { n: int() } } },
			});
			const { tab, resolves } = await relayed();
			expect(await rejection(tab.get(Misplaced, { n: 1 }, context))).toMatchObject({
				code: "invalid",
				reason: "host_address",
			});
			expect(resolves).toEqual([]);
		});
	});

	describe("resolve failures and re-resolves (no timer, slice 10 R2)", () => {
		fakeTimers();

		it("a rejected resolve fails its holders waiting with its error, is reported, and runs no timer (race 2)", async () => {
			let attempts = 0;
			const { tab, server, errors } = await relayed({
				resolve: async () => {
					attempts++;
					throw new Error("no worker");
				},
			});
			// One relayed from the tab, one the server's own.
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			const own = server.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			for (const ref of [notes, own]) {
				expect(ref.state.value).toMatchObject({
					kind: "failed",
					cause: { kind: "waiting", error: { code: "unavailable", message: "session|S1: no worker" } },
				});
			}
			expect(errors.server).toMatchObject([{ kind: "resolve_failed", address: "session|S1" }]);
			await elapse(120_000);
			expect(attempts).toBe(1);
		});

		it("a new hold resolves a failed address again; the earlier holders bind on its link without a re-hold (Q1)", async () => {
			let fail = true;
			const { tab, resolves } = await relayed({
				resolve: async (_address, worker) => {
					if (fail) throw new Error("no worker");
					return worker();
				},
			});
			const first = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(first.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			fail = false;
			const second = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(resolves).toEqual(["session|S1"]);
			expect([first.state.value, second.state.value]).toEqual([{ kind: "live" }, { kind: "live" }]);
		});

		it("RouteHandle.retry resolves a failed address now; a retry of an address nobody holds keeps nothing", async () => {
			let fail = true;
			const { tab, route, resolves } = await relayed({
				resolve: async (_address, worker) => {
					if (fail) throw new Error("no worker");
					return worker();
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			fail = false;
			route.retry(Session({ id: "S1" }));
			route.retry(Session({ id: "S9" }));
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			expect(resolves).toEqual(["session|S1"]);
		});

		it("a returned link closed already fails the holders", async () => {
			const { tab } = await relayed({
				resolve: async (address) => {
					const [a, b] = memoryLinkPair();
					b.close();
					await flushed();
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting", error: { message: "session|S1: the link closed before its handshake" } },
			});
		});

		it("a link closing before its handshake fails its holders: no re-resolve loop over a worker dying at start", async () => {
			let attempts = 0;
			const { tab } = await relayed({
				resolve: async (address) => {
					attempts++;
					const [a, b] = memoryLinkPair();
					setTimeout(() => b.close(), 10);
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await elapse(10);
			expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			await elapse(120_000);
			expect(attempts).toBe(1);
		});

		it("a dropped link that completed its handshake resolves again at once, once (race 6)", async () => {
			const { tab, resolves, routeLinks, workers } = await relayed();
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			const first = workers.get("session|S1")!;
			routeLinks[0]!.close();
			await transported();
			expect(resolves).toEqual(["session|S1", "session|S1"]);
			expect(workers.get("session|S1")).not.toBe(first);
			expect(notes.state.value).toEqual({ kind: "live" });
			await addNote(workers.get("session|S1")!, "S1", "fresh");
			await transported();
			expect(notes.notes.value).toEqual([{ text: "fresh" }]);
		});

		it("a link whose peer never greets closes after 30 s of silence and fails its holders", async () => {
			// The heartbeat's timer too, before the hosts start it.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });
			let attempts = 0;
			const { tab } = await relayed({
				resolve: async (address) => {
					attempts++;
					// Its other end is never read: no hello, no close.
					const [a] = memoryLinkPair();
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await elapse(29_000);
			expect(notes.state.value).toEqual({ kind: "loading" });
			// The heartbeat checks every 1.5 s: the silent link closes within it.
			await elapse(2_500);
			expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			await elapse(120_000);
			expect(attempts).toBe(1);
		});

		it("an address without holds is not resolved again after its link drops", async () => {
			const { tab, resolves, routeLinks } = await relayed();
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			notes.release();
			await transported();
			routeLinks[0]!.close();
			await elapse(60_000);
			expect(resolves).toEqual(["session|S1"]);
		});

		it("a resolve whose holds were all released meanwhile finishes and its link is kept (race 3)", async () => {
			let finish: () => void = () => {};
			const { tab, resolves, routeLinks, server } = await relayed({
				resolve: async (_address, worker) => {
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
					return worker();
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			notes.release();
			await transported();
			finish();
			await transported();
			expect(resolves).toEqual(["session|S1"]);
			let closed = false;
			routeLinks[0]!.onClose(() => {
				closed = true;
			});
			await elapse(60_000);
			expect(closed).toBe(false);
			// The kept link serves the next hold without a resolve.
			await tab.get(PlacedNotes, { session: "S1" }, context);
			expect(resolves).toEqual(["session|S1"]);
			await server.close(context);
			expect(closed).toBe(true);
		});
	});

	describe("RouteHandle.suspend (R1, Q3)", () => {
		it("resolves nothing while held: the holders fail waiting suspended once the link is gone; retry lifts it", async () => {
			const { tab, route, resolves, routeLinks } = await relayed();
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			route.suspend(Session({ id: "S1" }));
			expect(notes.state.value).toEqual({ kind: "live" });
			routeLinks[0]!.close();
			await transported();
			expect(notes.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting", error: { code: "unavailable", message: "session|S1: suspended" } },
			});
			const another = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(another.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			expect(resolves).toEqual(["session|S1"]);
			route.retry(Session({ id: "S1" }));
			await transported();
			expect(resolves).toEqual(["session|S1", "session|S1"]);
			expect([notes.state.value, another.state.value]).toEqual([{ kind: "live" }, { kind: "live" }]);
		});

		it("goes with the last holder: a later hold resolves on demand; an unheld address is never suspended", async () => {
			const { tab, route, resolves, routeLinks } = await relayed();
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			route.suspend(Session({ id: "S1" }));
			routeLinks[0]!.close();
			await transported();
			notes.release();
			await transported();
			route.suspend(Session({ id: "S1" }));
			await tab.get(PlacedNotes, { session: "S1" }, context);
			expect(resolves).toEqual(["session|S1", "session|S1"]);
		});
	});

	describe("host.close during a resolve (race 7)", () => {
		it("aborts the resolve's context and closes a link returned afterwards", async () => {
			let routing: AbortSignal | undefined;
			let finish: () => void = () => {};
			const { tab, server, routeLinks } = await relayed({
				resolve: async (_address, worker, context) => {
					routing = context.abortSignal;
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
					return worker();
				},
			});
			tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(routing?.aborted).toBe(false);
			await server.close(context);
			expect(routing?.aborted).toBe(true);
			finish();
			await transported();
			let closed = false;
			routeLinks[0]!.onClose(() => {
				closed = true;
			});
			expect(closed).toBe(true);
		});
	});

	describe("declaring routes", () => {
		it("is done before load, once per kind", async () => {
			const host = createHost<TestPrincipal>({ onError: () => {} });
			const options = { authorize: () => true, resolve: () => new Promise<never>(() => {}) };
			host.route(Session, options, context);
			expect(() => host.route(Session, options, context)).toThrow("route: session is routed already");
			await host.load([], context);
			expect(() => host.route(hostKind("other"), options, context)).toThrow(
				"route: routes are declared before load",
			);
		});
	});

	describe("a route's context", () => {
		it("is the parent of its resolves and of the work arriving on its links", async () => {
			const App = createContextKey<string>("app");
			const Who = remote("app.who", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { methods: { app: method(undefined, str()) } } },
			});
			const resolved: (string | undefined)[] = [];
			let worker: Host<TestPrincipal> | undefined;
			const server = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			server.route(
				Session,
				{
					authorize: () => true,
					resolve: async (address, routing) => {
						resolved.push(routing.value(App));
						const [a, b] = memoryLinkPair();
						worker = createHost<TestPrincipal>({
							address,
							principal: { kind: "worker", session: "S1" },
							onError: () => {},
						});
						worker.connect(b, { principal: { kind: "server" } }, context);
						await worker.load(
							[
								{
									name: "@test/worker",
									facet: defineFacet<TestPrincipal>((h) => void serveNotes(h, PlacedNotes)),
								},
							],
							context,
						);
						return { link: a, principal: { kind: "worker", session: "S1" } };
					},
				},
				withContextValue(App, "the app's", context),
			);
			const facet = defineFacet<TestPrincipal>((h) =>
				h.serve(Who, () => ({ variant: "v", members: { app: async (ctx) => ctx.value(App) ?? "none" } })),
			);
			await server.load([{ name: "@test/server", facet }], context);
			server.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			await transported();
			// The worker's call reaches the server over the route link: its handler runs under the route's context.
			const who = await worker!.get(Who, {}, context);
			expect(await who.app(context)).toBe("the app's");
			expect(resolved).toEqual(["the app's"]);
		});
	});

	describe("GC", () => {
		it("a failed or suspended address keeps no route state once its holders are released", async () => {
			const { refs, server } = await (async () => {
				const refs: WeakRef<object>[] = [];
				const { tab, server, route, routeLinks, workers, errors } = await relayed({
					authorize: (_principal, address) => {
						refs.push(new WeakRef(address));
						return true;
					},
					resolve: async (address, worker) => {
						if (address.params.id === "failed") throw new Error("no worker");
						return worker();
					},
				});
				const failed = tab.hold(PlacedNotes, { session: "failed" }, context);
				const held = await tab.get(PlacedNotes, { session: "held" }, context);
				route.suspend(Session({ id: "held" }));
				routeLinks[0]!.close();
				await transported();
				for (const ref of [failed, held]) ref.release();
				await transported();
				// The reported error's stack keeps the test's `resolve` frame (and its address) alive, the worker host its
				// own address: not the route's.
				errors.server.length = 0;
				routeLinks.length = 0;
				workers.clear();
				return { refs, server };
			})();
			await expectCollected(...refs);
			expect(server).toBeDefined();
		});

		it("a closed route link and its released references keep no route state", async () => {
			const { refs, tab } = await (async () => {
				const { tab, routeLinks, workers } = await relayed();
				const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
				const refs = [new WeakRef(notes), new WeakRef(workers.get("session|S1")!), new WeakRef(routeLinks[0]!)];
				notes.release();
				await transported();
				routeLinks[0]!.close();
				workers.clear();
				routeLinks.length = 0;
				await transported();
				return { refs, tab };
			})();
			await expectCollected(...refs);
			expect(tab).toBeDefined();
		});

		it("holds released while their resolve never settles are not kept", async () => {
			const { refs, server } = await (async () => {
				const { tab, server } = await relayed({ resolve: () => new Promise<never>(() => {}) });
				const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
				await transported();
				notes.release();
				await transported();
				return { refs: [new WeakRef(notes)], server };
			})();
			await expectCollected(...refs);
			expect(server).toBeDefined();
		});
	});
});
