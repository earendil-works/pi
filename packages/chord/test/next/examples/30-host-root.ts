// `host.root(fn, context)`: a call scope for code outside objects (a Durable tool, a CLI command). `fn` gets a ctx like a
// method handler's: the host's principal (or one a trusted caller names), this host's incarnation, the context's
// telemetry and signal, and `ctx.get` for references. When `fn` settles, or the context aborts, or the host closes, the
// scope is sealed: its signal aborts, its references are released, and a late `ctx.get` is refused `released`; so code
// that ignores its signal fails at its next use of Chord. (p3 wraps it as `chord(fn, context)` for Durable's tools.)
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/30-host-root.ts
import { BACKGROUND_CONTEXT, withCancel } from "../../../src/context/index.ts";
import { arr, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { type Ctx, createHost, defineFacet, sleep } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

type Principal = { readonly kind: "server" } | { readonly kind: "owner"; readonly name: string };

const Notes = local("example.notes", {
	version: 1,
	params: { session: str() },
	members: { list: arr(str()), add: method(obj({ text: str() })) },
});

const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

const facet = defineFacet<Principal>((host) => {
	host.serve(Notes, (_, self) => {
		const notes = self.state(List);
		return {
			list: self.derive([notes], ([n]) => n.list),
			add: async ({ text }, ctx) => {
				await notes.change((draft) => {
					draft.list.push(`${text} (by ${ctx.principal?.kind})`);
				}, ctx);
				return null;
			},
		};
	});
});

const host = createHost<Principal>({ principal: { kind: "server" }, onError: (error) => console.log(error.kind) });

// 1. A scope made before `load` resolved: its `ctx.get` parks until the host is loaded.
const early = host.root(async (ctx) => (await ctx.get(Notes, { session: "s1" })).list.value, context);
await host.load([{ name: "@example/notes", facet }], context);
console.log("before load, read after it:", await early);

// 2. A tool's call: get, call, return plain data. The reference is released when fn settles.
const addNote = (text: string) =>
	host.root(async (ctx) => {
		const notes = await ctx.get(Notes, { session: "s1" });
		await notes.add({ text }, ctx);
		return notes.list.value;
	}, context);
console.log("after a tool call:", await addNote("first"));

// 3. Base code acting for an authenticated user names the principal.
const owner: Principal = { kind: "owner", name: "ada" };
console.log("as the owner:", await host.root(async (ctx) => ctx.principal, context, { principal: owner }));

// 4. A kept ctx is sealed once fn settled.
let kept: Ctx<Principal> | undefined;
await host.root(async (ctx) => {
	kept = ctx;
}, context);
console.log("kept ctx aborted:", kept!.abortSignal?.aborted);
await kept!.get(Notes, { session: "s1" }).catch((error: Error) => console.log("kept ctx.get:", error.message));

// 5. Cancelling the context rejects at once and seals the scope; an fn that ignores its signal fails at its next
//    use of Chord.
const { context: cancellable, cancel } = withCancel(context);
const stubborn = host.root(async (ctx) => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ctx.get(Notes, { session: "s1" });
}, cancellable);
cancel(new Error("user pressed stop"));
await stubborn.catch((error: Error) => console.log("cancelled:", error.message));

// 6. Closing the host seals the scopes still open and rejects their callers at once: an fn sleeping on its ctx ends.
const sleeping = host.root((ctx) => sleep(60_000, ctx), context).catch((error: Error) => `closed: ${error.message}`);
await host.close(context);
console.log(await sleeping);
