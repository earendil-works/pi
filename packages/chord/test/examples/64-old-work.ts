// Old work finishes on old code (decision "Reload restarts every affected object; old work finishes on old code"). A
// reload restarts every live object of a changed plugin. The calls running at the commit, and every call they cause
// (found through the `ctx` they pass on, and over trusted links), are old work: they run on the old attempts, which
// stay open until that work drained and their successors' requests are ready. New calls wait for the new code. Here:
// a provider's running call reaches its dependent while both restart, once with the provider's contract raised; a wait
// that would cycle through its own drain fails at once; and a call still running at `reloadDrainTimeout` is cut.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/64-old-work.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { evolve, local, method, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { type Ctx, createHost, defineFacet } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

const context = BACKGROUND_CONTEXT;

/** A provider: `work` reaches back into the plugin once `gate` opens; `x` answers its code. */
const Provider = local("example.provider", {
	version: 1,
	params: {},
	members: { work: method(undefined, str()), x: method(undefined, str()) },
});

/** The provider raised by a reload: a new member, version 1 still accepted. */
const ProviderV2 = evolve(Provider, (e) => e.addState("extra", str()));

/** A dependent: it holds the provider, and `ping` calls the provider's `x` back. */
const Dependent = local("example.dependent", { version: 1, params: {}, members: { ping: method(undefined, str()) } });

let gate = Promise.withResolvers<void>();

/** The plugin at `code`; `raised` serves `ProviderV2` (the dependent's code then needs it). */
function plugin(code: string, raised = false) {
	const P = raised ? ProviderV2 : Provider;
	return defineFacet((host) => {
		host.serve(
			P as typeof Provider,
			() => ({
				...(raised ? { extra: constant("x") } : {}),
				work: async (ctx: Ctx) => {
					await gate.promise;
					const dependent = await ctx.get(Dependent, {});
					return `${code} work -> ${await dependent.ping(ctx)}`;
				},
				x: async () => `${code} x`,
			}),
			raised ? { accepts: { 1: {} } } : {},
		);
		host.serve(Dependent, (_, self) => {
			const provider = self.get(P as typeof Provider, {});
			return { ping: async (ctx: Ctx) => `${code} ping -> ${await provider.x(ctx)}` };
		});
	});
}

/** Starts `work`, reloads to `next` while it waits at its gate, then opens the gate: prints how `work` ended. */
async function workAcross(label: string, host: ReturnType<typeof createHost>, next: ReturnType<typeof plugin>) {
	gate = Promise.withResolvers();
	const provider = await host.get(Provider, {}, context);
	await host.get(Dependent, {}, context);
	const working = provider
		.work(context)
		.catch((error: ChordError) => `${error.code}/${error.reason}: ${error.message}`);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const report = await host.reload([{ name: "@example/app", facet: next }], context);
	const started = Date.now();
	gate.resolve();
	console.log(`${label}\n   reload: ${report.objects.map(({ object, kind }) => `${object} ${kind}`).join(", ")}`);
	console.log(`   work: ${await working} (${Date.now() - started < 1000 ? "at once" : "late"})`);
	console.log(`   a new call: ${await provider.x(context)}`);
}

// 1. Both objects restart while the provider's `work` runs. Its `ctx.get` of the dependent reaches the dependent's new
//    attempt, which binds the provider's open old attempt; the back-call `x` is old work too, so it runs on the
//    provider's old code. No call waits for the drain it is part of.
const host = createHost({ onError: () => {} });
await host.load([{ name: "@example/app", facet: plugin("v1") }], context);
await workAcross("1. both restart", host, plugin("v2"));

// 2. The reload raises the provider's version and the dependent's new code needs it. The dependent's successor waits
//    for the provider's (which waits for `work`): its old attempt stays open, and `work` (started on v2, the code now
//    replaced) runs on the old code there.
await workAcross("2. the provider's version raised", host, plugin("v3", true));
await host.close(context);

// 3. Old work that would wait for its own drain: `work` creates an object whose new code needs the raised provider,
//    whose new attempt waits for `work` to end. It fails at once with `unavailable/reload_cycle`, naming the chain,
//    instead of waiting for the reload drain bound.
// With params: an object of no params is a host-lifetime one, opened at the load.
const Fresh = local("example.fresh", {
	version: 1,
	params: { id: str() },
	members: { ping: method(undefined, str()) },
});
const cycling = (code: string, raised: boolean) =>
	defineFacet((h) => {
		const P = raised ? ProviderV2 : Provider;
		h.serve(
			P as typeof Provider,
			() => ({
				...(raised ? { extra: constant("x") } : {}),
				work: async (ctx: Ctx) => {
					await gate.promise;
					return (await ctx.get(Fresh, { id: "new" })).ping(ctx);
				},
				x: async () => code,
			}),
			raised ? { accepts: { 1: {} } } : {},
		);
		h.serve(Dependent, () => ({ ping: async () => code }));
		h.serve(Fresh, (_, self) => {
			if (raised) self.get(ProviderV2, {});
			return { ping: async () => `${code} fresh` };
		});
	});
const cycle = createHost({ onError: () => {} });
await cycle.load([{ name: "@example/app", facet: cycling("v1", false) }], context);
await workAcross("3. a wait through its own drain", cycle, cycling("v2", true));
await cycle.close(context);

// 4. A call still running at `reloadDrainTimeout` (default 5 s, at most `closeTimeout`) is cut `released`: long work
//    belongs in jobs. Here the bound is 200 ms and `work` never opens its gate.
const bounded = createHost({ reloadDrainTimeout: 200, onError: () => {} });
await bounded.load([{ name: "@example/app", facet: plugin("v1") }], context);
const provider = await bounded.get(Provider, {}, context);
gate = Promise.withResolvers();
const stuck = provider.work(context).catch((error: ChordError) => `${error.code}: ${error.message}`);
await new Promise((resolve) => setTimeout(resolve, 0));
const cutAt = Date.now();
await bounded.reload([{ name: "@example/app", facet: plugin("v2") }], context);
console.log(
	`4. the reload drain bound\n   work: ${await stuck} (after ${Math.round((Date.now() - cutAt) / 100) * 100} ms)`,
);
console.log(`   a new call: ${await provider.x(context)}`);
gate.resolve();
await bounded.close(context);
