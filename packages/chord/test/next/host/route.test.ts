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

		it("fails a hold broken invalid/placement for an address whose params do not fit the kind", async () => {
			const Misplaced = remote("app.misplaced", {
				version: 1,
				params: { n: int() },
				// An address of the right kind with params of the wrong type, as a buggy placement could compute.
				placement: ({ n }) => ({ kind: "session", params: { id: n }, key: "" }) as never,
				variants: { v: { state: { n: int() } } },
			});
			const { tab, resolves } = await relayed();
			expect(await rejection(tab.get(Misplaced, { n: 1 }, context))).toMatchObject({
				code: "invalid",
				reason: "placement",
			});
			expect(resolves).toEqual([]);
		});
	});

	describe("resolve failures and re-resolves", () => {
		fakeTimers();

		it("a rejected resolve leaves the holds loading, is reported, and resolves again after the address's backoff (race 2)", async () => {
			let failures = 2;
			const { tab, resolves, errors } = await relayed({
				resolve: async (_address, worker) => {
					if (failures-- > 0) throw new Error("no worker yet");
					return worker();
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(errors.server).toMatchObject([{ kind: "resolve_failed", address: "session|S1" }]);
			await elapse(999);
			expect(errors.server).toHaveLength(1);
			await elapse(1);
			// The second failure doubles the window.
			expect(errors.server).toHaveLength(2);
			await elapse(1999);
			expect(notes.state.value).toEqual({ kind: "loading" });
			await elapse(1);
			expect(resolves).toEqual(["session|S1"]);
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it("a returned link that is closed already starts the backoff", async () => {
			let closed = true;
			const { tab, resolves } = await relayed({
				resolve: async (address, worker) => {
					if (!closed) return worker();
					closed = false;
					const [a, b] = memoryLinkPair();
					b.close();
					await flushed();
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			await elapse(1000);
			expect(resolves).toEqual(["session|S1"]);
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it("a dropped link resolves again while held: references go loading, then live on a fresh worker (race 6)", async () => {
			const { tab, resolves, routeLinks, workers } = await relayed();
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			const first = workers.get("session|S1")!;
			routeLinks[0]!.close();
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			await elapse(1000);
			expect(resolves).toEqual(["session|S1", "session|S1"]);
			expect(workers.get("session|S1")).not.toBe(first);
			expect(notes.state.value).toEqual({ kind: "live" });
			await addNote(workers.get("session|S1")!, "S1", "fresh");
			await transported();
			expect(notes.notes.value).toEqual([{ text: "fresh" }]);
		});

		it("only a link that completed its handshake resets the backoff", async () => {
			let silent = 0;
			const { tab, resolves, routeLinks } = await relayed({
				resolve: async (address, worker) => {
					if (silent-- <= 0) return worker();
					// A link whose other end never greets and closes.
					const [a, b] = memoryLinkPair();
					setTimeout(() => b.close(), 10);
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
			silent = 1;
			routeLinks[0]!.close();
			await elapse(1000);
			// The silent link closed before its handshake: the window doubles.
			await elapse(10);
			await elapse(1999);
			expect(resolves).toEqual(["session|S1"]);
			await elapse(1);
			expect(resolves).toEqual(["session|S1", "session|S1"]);
			expect(notes.state.value).toEqual({ kind: "live" });
			// That link greeted: the next drop starts again at 1 s.
			routeLinks.at(-1)!.close();
			await elapse(1000);
			expect(resolves).toHaveLength(3);
		});

		it("a link whose peer never greets closes after 30 s of silence; the address backs off, then resolves again while held", async () => {
			// The heartbeat's timer too, before the hosts start it.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });
			let silent = true;
			const { tab, resolves } = await relayed({
				resolve: async (address, worker) => {
					if (!silent) return worker();
					silent = false;
					// Its other end is never read: no hello, no close.
					const [a] = memoryLinkPair();
					return { link: a, principal: { kind: "worker", session: address.params.id } };
				},
			});
			const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
			await elapse(29_000);
			expect(resolves).toEqual([]);
			expect(notes.state.value).toEqual({ kind: "loading" });
			// The heartbeat checks every 1.5 s: the silent link closes within it, then its address waits 1 s.
			await elapse(2_500);
			await elapse(1_000);
			expect(resolves).toEqual(["session|S1"]);
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
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
				variants: { v: { methods: { app: method(undefined, str()) } } },
			});
			const resolved: (string | undefined)[] = [];
			let worker: Host<TestPrincipal> | undefined;
			const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
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
