import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { int, local, method, remote, str } from "../../../src/next/contracts/index.ts";
import { withLinkedAbortSignal } from "../../../src/next/host/ctx.ts";
import type { ChordHost } from "../../../src/next/host/host.ts";
import type { Ctx, Host, Reference } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	flushed,
	incarnationOf,
	linked,
	loaded,
	rawParent,
	rejection,
	Server,
	type TestPrincipal,
} from "../support.ts";

const Item = local("app.item", { version: 1, params: { id: int() }, members: { id: int() } });
const Desk = local("app.desk", {
	version: 1,
	params: {},
	members: { use: method(undefined, int()), leak: method(), late: method(), who: method(undefined, str()) },
});

/** A desk whose handlers use `ctx.get`; what they got and their contexts are recorded. */
async function desk() {
	const seen: { ctx?: Ctx; item?: Reference<typeof Item>; late?: Promise<unknown>; factories: number } = {
		factories: 0,
	};
	const { host } = await loaded((h) => {
		h.serve(Item, ({ id }) => {
			seen.factories++;
			return { id: constant(id) };
		});
		h.serve(Desk, () => ({
			use: async (ctx) => {
				const item = await ctx.get(Item, { id: 1 });
				return item.id.value;
			},
			leak: async (ctx) => {
				seen.ctx = ctx;
				seen.item = await ctx.get(Item, { id: 2 });
				return null;
			},
			late: async (ctx) => {
				seen.late = ctx.get(Item, { id: 3 }).catch((error: unknown) => error);
				return null;
			},
			who: async (ctx) => `${ctx.principal?.kind ?? "none"} ${ctx.incarnation}`,
		}));
	});
	return { host, seen, desk: await host.get(Desk, {}, context) };
}

describe("ctx", () => {
	it("ctx.get references are released when the handler settles", async () => {
		const { desk: ref, seen } = await desk();
		expect(await ref.use(context)).toBe(1);
		await ref.leak(context);
		expect(() => seen.item!.id.value).toThrow("app.item: released");
		// The object ended with its last reference: a new get creates it anew.
		await ref.use(context);
		expect(seen.factories).toBe(3);
	});

	it("ctx.get after the handler settled throws released", async () => {
		const { desk: ref, seen } = await desk();
		await ref.leak(context);
		expect(await rejection(seen.ctx!.get(Item, { id: 1 }))).toEqual({
			code: "released",
			reason: "settled",
			message: "app.item: ctx.get after its call settled",
		});
	});

	it("ctx.get of a handler whose call was aborted checks the signal first: nothing is created", async () => {
		let factories = 0;
		let got: Promise<unknown> | undefined;
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => {
			h.serve(Item, ({ id }) => {
				factories++;
				return { id: constant(id) };
			});
			h.serve(Desk, () => ({
				use: async (ctx) => {
					await gate.promise;
					got = ctx.get(Item, { id: 1 }).catch((error: unknown) => error);
					return 0;
				},
				leak: async () => null,
				late: async () => null,
				who: async () => "",
			}));
		});
		const ref = await host.get(Desk, {}, context);
		const caller = new AbortController();
		const call = ref.use(withAbortSignal(caller.signal, context)).catch(() => {});
		await flushed();
		caller.abort(new Error("caller gave up"));
		gate.resolve();
		await call;
		await flushed();
		expect(await got).toEqual(new Error("caller gave up"));
		expect(factories).toBe(0);
	});

	it("a ctx.get finishing after its handler settled is released at once (race 11)", async () => {
		const { desk: ref, seen } = await desk();
		await ref.late(context);
		expect(await seen.late).toMatchObject({
			code: "released",
			reason: "settled",
			message: "app.item: ctx.get after its call settled",
		});
		await flushed();
		// The late reference's object ended with it.
		expect(seen.factories).toBe(1);
	});

	it("a ctx.get still waiting when its handler settles gives up: its reference is released at once", async () => {
		const Far = remote("app.far", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: int() } } },
		});
		const Starter = local("app.starter", { version: 1, params: {}, members: { start: method() } });
		let pending: Promise<unknown> | undefined;
		const { host } = await loaded((h) =>
			h.serve(Starter, () => ({
				start: async (ctx) => {
					pending = ctx.get(Far, {}).catch((error: unknown) => error);
					return null;
				},
			})),
		);
		// A host of any principal type takes a parent link.
		const parent = await rawParent(host as Host<TestPrincipal>);
		await (await host.get(Starter, {}, context)).start(context);
		const { hold } = await parent.next("hold");
		expect(await parent.next("release")).toMatchObject({ hold });
		expect(await pending).toMatchObject({
			code: "released",
			reason: "settled",
			message: "app.far: ctx.get after its call settled",
		});
	});

	it("a local handler's ctx.principal is the host's, its incarnation this host's", async () => {
		const { desk: ref, host } = await desk();
		expect(await ref.who(context)).toBe(`none ${(host as ChordHost).incarnation}`);
	});
});

describe("local handlers act as the host (§4, audit)", () => {
	it("a local object called from a remote handler's ctx.get runs with this host's principal and incarnation", async () => {
		const Store = local("app.local-store", { version: 1, params: {}, members: { who: method(undefined, str()) } });
		const Gate = remote("app.gate", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { methods: { who: method(undefined, str()), through: method(undefined, str()) } } },
		});
		const who = (ctx: Ctx<TestPrincipal>) => `${ctx.principal?.kind ?? "none"} ${ctx.incarnation}`;
		const { server, client } = await linked((h) => {
			h.serve(Store, () => ({ who: async (ctx) => who(ctx) }));
			h.serve(Gate, () => ({
				variant: "v",
				members: {
					who: async (ctx) => who(ctx),
					through: async (ctx) => (await ctx.get(Store, {})).who(ctx),
				},
			}));
		});
		const gate = await client.get(Gate, {}, context);
		// The remote handler acts as its caller; the local object it reaches acts as this host, both halves.
		expect(await gate.who(context)).toBe(`owner ${incarnationOf(client)}`);
		expect(await gate.through(context)).toBe(`server ${incarnationOf(server)}`);
	});
});

describe("linked abort signals", () => {
	it("abort with the caller's signal or the call's, the caller's reason first", () => {
		for (const first of ["caller", "call"] as const) {
			const [caller, call] = [new AbortController(), new AbortController()];
			const { context: linked } = withLinkedAbortSignal(call.signal, withAbortSignal(caller.signal, context));
			(first === "caller" ? caller : call).abort(first);
			expect(linked.abortSignal?.reason).toBe(first);
		}
		const [caller, call] = [new AbortController(), new AbortController()];
		call.abort("call");
		caller.abort("caller");
		const { context: linked } = withLinkedAbortSignal(call.signal, withAbortSignal(caller.signal, context));
		expect(linked.abortSignal?.reason).toBe("caller");
	});

	it("detach from both sources on release: a later abort reaches nothing", () => {
		const [caller, call] = [new AbortController(), new AbortController()];
		const linked = withLinkedAbortSignal(call.signal, withAbortSignal(caller.signal, context));
		linked.release();
		caller.abort("late");
		call.abort("late");
		expect(linked.context.abortSignal?.aborted).toBe(false);
	});

	it("is the call's own signal without a caller's", () => {
		const call = new AbortController();
		const linked = withLinkedAbortSignal(call.signal, context);
		expect(linked.context.abortSignal).toBe(call.signal);
		linked.release();
	});
});
