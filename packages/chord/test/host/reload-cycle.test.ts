// Tests of reload cycles (decision "Reload restarts every affected object; old work finishes on old code", rule 6): a
// wait of old work on an object whose activation waits on the old attempt that very work runs on fails at once with
// `unavailable/reload_cycle`, naming the chain, whether the cycle is closed when the wait starts or closes later; and
// that neither the waits nor an opener's gate waits keep anything once they ended.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, method, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type Self } from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { constant } from "../../src/state/index.ts";
import { expectCollected, flushed, instancesOf, rejection } from "../support.ts";

const Provider = local("app.p", {
	version: 1,
	params: {},
	members: { work: method(undefined, str()), x: method(undefined, str()) },
});
const Fresh = local("app.f", { version: 1, params: { id: str() }, members: { ping: method(undefined, str()) } });

describe("a wait of old work that cycles through its own drain", () => {
	it("fails at once when old work creates an object whose new code needs the provider's raised contract", async () => {
		const Raised = local("app.p", {
			version: 2,
			params: {},
			members: { work: method(undefined, str()), x: method(undefined, str()), n: int() },
		});
		const gate = Promise.withResolvers<void>();
		const facet = (code: "v1" | "v2") =>
			defineFacet((h) => {
				if (code === "v1")
					h.serve(Provider, () => ({
						work: async (ctx) => {
							await gate.promise;
							return (await ctx.get(Fresh, { id: "fresh" })).ping(ctx);
						},
						x: async () => "v1 x",
					}));
				else h.serve(Raised, () => ({ n: constant(0), work: async () => "v2", x: async () => "v2 x" }));
				h.serve(Fresh, (_, self) => {
					// v2 needs the raised provider: its new attempt, which waits for this very work's drain.
					if (code === "v1") self.get(Provider, {});
					else self.get(Raised, {});
					return { ping: async () => `${code} f` };
				});
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet("v1") }], context);
		const provider = await host.get(Provider, {}, context);
		const working = rejection(provider.work(context));
		await flushed();
		await host.reload([{ name: "@test/app", facet: facet("v2") }], context);
		const opened = performance.now();
		gate.resolve();
		const error = (await working) as ChordError;
		expect(error).toMatchObject({ code: "unavailable", reason: "reload_cycle" });
		expect(error.message).toBe(
			"app.f(fresh): work its reload drains waits for it, and it waits for that drain (app.f(fresh) → app.p)",
		);
		// The reload drain bound (5 s) never came into it.
		expect(performance.now() - opened).toBeLessThan(1_000);
		await host.close(context);
	});

	it("fails once a later wait closes the cycle: the new attempt's opener calls the provider old work waits on", async () => {
		const Dependent = local("app.d", { version: 1, params: {}, members: { ping: method(undefined, str()) } });
		const gate = Promise.withResolvers<void>();
		const facet = (code: "v1" | "v2") =>
			defineFacet((h) => {
				h.serve(Provider, () => ({
					work: async (ctx) => {
						await gate.promise;
						return (await ctx.get(Dependent, {})).ping(ctx);
					},
					x: async () => `${code} x`,
				}));
				h.serve(Dependent, (_, self) => {
					const provider = self.get(Provider, {});
					// The new code's opener calls the provider: new work, which waits at its gate for its new attempt.
					if (code === "v2")
						self.open(
							async (opening) => provider.x(opening),
							() => {},
						);
					return { ping: async () => `${code} ping` };
				});
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet("v1") }], context);
		const provider = await host.get(Provider, {}, context);
		await host.get(Dependent, {}, context);
		const working = rejection(provider.work(context));
		await flushed();
		await host.reload([{ name: "@test/app", facet: facet("v2") }], context);
		const opened = performance.now();
		gate.resolve();
		const error = (await working) as ChordError;
		expect(error).toMatchObject({ code: "unavailable", reason: "reload_cycle" });
		expect(error.message).toContain("(app.d → app.p)");
		expect(performance.now() - opened).toBeLessThan(1_000);
		await host.close(context);
	});

	it("does not fail a wait whose target waits on another object's drain only (no cycle through this work)", async () => {
		const Dependent = local("app.d", { version: 1, params: {}, members: { ping: method(undefined, str()) } });
		const gate = Promise.withResolvers<void>();
		const facet = (code: "v1" | "v2") =>
			defineFacet((h) => {
				h.serve(Provider, () => ({
					work: async (ctx) => {
						await gate.promise;
						return (await ctx.get(Dependent, {})).ping(ctx);
					},
					x: async () => `${code} x`,
				}));
				h.serve(Dependent, (_, self) => {
					self.get(Provider, {});
					return { ping: async () => `${code} ping` };
				});
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet("v1") }], context);
		const provider = await host.get(Provider, {}, context);
		const working = provider.work(context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: facet("v2") }], context);
		gate.resolve();
		// The dependent's new attempt binds the provider's open old attempt: the work's wait ends, never cut.
		expect(await working).toBe("v2 ping");
		await host.close(context);
	});
});

describe("memory", () => {
	const reloaded = instancesOf(ChordObject, "reload");

	it("a cut wait keeps neither its target nor the old attempt it ran on", async () => {
		const Raised = local("app.p", {
			version: 2,
			params: {},
			members: { work: method(undefined, str()), x: method(undefined, str()), n: int() },
		});
		const gate = Promise.withResolvers<void>();
		const selves: WeakRef<Self>[] = [];
		const facet = (code: "v1" | "v2") =>
			defineFacet((h) => {
				if (code === "v1")
					h.serve(Provider, (_, self) => {
						selves.push(new WeakRef(self));
						return {
							work: async (ctx) => {
								await gate.promise;
								return (await ctx.get(Fresh, { id: "fresh" })).ping(ctx);
							},
							x: async () => "v1 x",
						};
					});
				else h.serve(Raised, () => ({ n: constant(0), work: async () => "v2", x: async () => "v2 x" }));
				h.serve(Fresh, (_, self) => {
					selves.push(new WeakRef(self));
					self.get(code === "v1" ? Provider : Raised, {});
					return { ping: async () => `${code} f` };
				});
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet("v1") }], context);
		const provider = await host.get(Provider, {}, context);
		const working = rejection(provider.work(context));
		await flushed();
		await host.reload([{ name: "@test/app", facet: facet("v2") }], context);
		gate.resolve();
		expect(await working).toMatchObject({ reason: "reload_cycle" });
		await flushed();
		// The old provider and the fresh object's attempts, the wait's chain and target.
		await expectCollected(...selves);
		provider.release();
		await host.close(context);
	});

	it("an opener's gate wait leaves no wait edge once it ended, nor keeps the old attempt", async () => {
		const Dependent = local("app.d", { version: 1, params: {}, members: { ping: method(undefined, str()) } });
		const gate = Promise.withResolvers<void>();
		const selves: WeakRef<Self>[] = [];
		const facet = (code: "v1" | "v2") =>
			defineFacet((h) => {
				h.serve(Provider, (_, self) => {
					if (code === "v1") selves.push(new WeakRef(self));
					return {
						work: async () => {
							await gate.promise;
							return `${code} work`;
						},
						x: async () => `${code} x`,
					};
				});
				h.serve(Dependent, (_, self) => {
					const provider = self.get(Provider, {});
					// The new code's opener calls the provider: it waits at its gate while the provider restarts.
					if (code === "v2")
						self.open(
							async (opening) => provider.x(opening),
							() => {},
						);
					return { ping: async () => `${code} ping` };
				});
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet("v1") }], context);
		const provider = await host.get(Provider, {}, context);
		const dependent = await host.get(Dependent, {}, context);
		const working = provider.work(context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: facet("v2") }], context);
		gate.resolve();
		expect(await working).toBe("v1 work");
		await vi.waitFor(async () => expect(await dependent.ping(context)).toBe("v2 ping"));
		const object = reloaded.map((ref) => ref.deref()).find((each) => each?.label === "app.d");
		expect(object?.waitEdges()).toEqual([]);
		await expectCollected(...selves);
		provider.release();
		dependent.release();
		await host.close(context);
	});
});
