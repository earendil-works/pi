import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, withCancel } from "../../../src/context/index.ts";
import { int, local, method } from "../../../src/next/contracts/index.ts";
import { type Ctx, createHost, defineFacet, sleep } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { expectCollected, flushed, loaded, rejection, type TestPrincipal } from "../support.ts";

const Info = local("app.info", { version: 1, params: { id: int() }, members: { id: int(), wait: method() } });

/** Serves `Info`; its `wait` waits until the caller's context aborts. */
function serveInfo(h: Parameters<Parameters<typeof loaded>[0]>[0]): void {
	h.serve(Info, ({ id }) => ({
		id: constant(id),
		wait: async (ctx) => {
			await sleep(60_000, ctx);
			return null;
		},
	}));
}

describe("host.root", () => {
	it("gives fn a call context: the host's principal (or the given one), this host's incarnation, `ctx.get`", async () => {
		const host = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		await host.load([{ name: "@app/info", facet: defineFacet<TestPrincipal>(serveInfo) }], context);
		const seen = await host.root(async (ctx) => {
			const info = await ctx.get(Info, { id: 7 });
			return { principal: ctx.principal, incarnation: ctx.incarnation, id: info.id.value };
		}, context);
		expect(seen).toMatchObject({ principal: { kind: "server" }, id: 7 });
		const owner = { kind: "owner", access: "local" } as const;
		expect(await host.root(async (ctx) => ctx.principal, context, { principal: owner })).toEqual(owner);
		await host.close(context);
	});

	it("seals the context when fn settles: its references released, its signal aborted, `ctx.get` refused `released`", async () => {
		const { host } = await loaded(serveInfo);
		let kept: Ctx | undefined;
		const info = await host.root(async (ctx) => {
			kept = ctx;
			return ctx.get(Info, { id: 1 });
		}, context);
		expect(info.state.value).toMatchObject({ kind: "ended", error: { code: "released" } });
		expect(kept!.abortSignal?.aborted).toBe(true);
		expect(await rejection(kept!.get(Info, { id: 1 }))).toMatchObject({ code: "released", reason: "settled" });
		// A throwing fn seals too, and rejects with its error.
		await expect(
			host.root(async () => {
				throw new Error("fn failed");
			}, context),
		).rejects.toThrow("fn failed");
		await host.close(context);
	});

	it("an abort rejects at once and seals: a running call through its reference rejects, a later get is `released`", async () => {
		const { host } = await loaded(serveInfo);
		const { context: cancellable, cancel } = withCancel(context);
		let kept: Ctx | undefined;
		let call: Promise<unknown> | undefined;
		const running = host.root(async (ctx) => {
			kept = ctx;
			const info = await ctx.get(Info, { id: 1 });
			call = info.wait(context);
			// Uncooperative: it waits on nothing of Chord's.
			await new Promise(() => {});
		}, cancellable);
		await flushed();
		cancel(new Error("stop"));
		expect(await rejection(running)).toEqual(new Error("stop"));
		expect(await rejection(call!)).toMatchObject({ code: "released" });
		expect(await rejection(kept!.get(Info, { id: 2 }))).toMatchObject({ code: "released", reason: "settled" });
		await host.close(context);
	});

	it("an aborted context rejects before fn runs; a synchronous throw is a rejection", async () => {
		const { host } = await loaded(serveInfo);
		const { context: aborted, cancel } = withCancel(context);
		cancel(new Error("gone"));
		let ran = false;
		const fn = async (): Promise<void> => {
			ran = true;
		};
		await expect(host.root(fn, aborted)).rejects.toThrow("gone");
		expect(ran).toBe(false);
		await expect(
			host.root(
				(() => {
					throw new Error("sync");
				}) as never,
				context,
			),
		).rejects.toThrow("sync");
		await host.close(context);
	});

	it("a `ctx.get` before `load` resolved parks until it did", async () => {
		const host = createHost({ onError: () => {} });
		const result = host.root(async (ctx) => (await ctx.get(Info, { id: 3 })).id.value, context);
		await flushed();
		await host.load([{ name: "@app/info", facet: defineFacet(serveInfo) }], context);
		expect(await result).toBe(3);
		await host.close(context);
	});

	it("`host.close` seals every open scope (an fn sleeping on its ctx ends); after it, `root` rejects `released`", async () => {
		const { host } = await loaded(serveInfo);
		const sleeping = rejection(host.root((ctx) => sleep(60_000, ctx), context));
		await flushed();
		await host.close(context);
		expect(await sleeping).toMatchObject({ code: "released", reason: "closed" });
		expect(await rejection(host.root(async () => 1, context))).toMatchObject({ code: "released", reason: "closed" });
	});

	it("aborts the scope's own signal when fn settles and at `host.close`, the caller's context having one (Fable, Opus, Sol)", async () => {
		const { host } = await loaded(serveInfo);
		const settled = withCancel(context);
		let kept: Ctx | undefined;
		await host.root(async (ctx) => {
			kept = ctx;
		}, settled.context);
		expect(kept!.abortSignal?.aborted).toBe(true);
		expect(settled.context.abortSignal?.aborted).toBe(false);
		const closing = withCancel(context);
		let slept: "running" | "ended" = "running";
		const sleeping = host.root(async (ctx) => {
			try {
				await sleep(60_000, ctx);
			} finally {
				slept = "ended";
			}
		}, closing.context);
		const outcome = rejection(sleeping);
		await flushed();
		await host.close(context);
		await flushed();
		expect(slept).toBe("ended");
		expect(closing.context.abortSignal?.aborted).toBe(false);
		expect(await outcome).toMatchObject({ code: "released", reason: "closed" });
	});

	it("`host.close` rejects the caller at once, whatever an uncooperative fn still does (Sol)", async () => {
		const { host } = await loaded(serveInfo);
		const running = host.root(() => new Promise<never>(() => {}), context);
		const outcome = running.then(
			() => "resolved",
			(error: unknown) => error,
		);
		await host.close(context);
		expect(await outcome).toMatchObject({ code: "released", reason: "closed" });
	});

	it("leaves no listener on the caller's signal once `host.close` rejected an fn that never settles (Astra)", async () => {
		const controller = new AbortController();
		const host = createHost({ onError: () => {} });
		const running = host.root(async () => new Promise<never>(() => {}), withAbortSignal(controller.signal, context));
		const rejected = running.catch((error: unknown) => error);
		await host.close(context);
		expect(await rejected).toMatchObject({ code: "released", reason: "closed" });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("keeps nothing once sealed: its scope and references are collected while the caller's signal lives on", async () => {
		const { host } = await loaded(serveInfo);
		const { context: long } = withCancel(context);
		const refs = await (async () => {
			const made: WeakRef<object>[] = [];
			await host.root(async (ctx) => {
				made.push(new WeakRef(ctx), new WeakRef(await ctx.get(Info, { id: 1 })));
			}, long);
			return made;
		})();
		await expectCollected(...refs);
		await host.close(context);
	});
});
