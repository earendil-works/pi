// Versions in use (slice 7b §7, §8): a provider keeps serving older consumers through `accepts`, written once with the
// provider, never in the shared contract (Q10). Here the server's notes go from v1 to v2 while an old tab, still on v1,
// stays connected: it reads the new state mapped back (as diffs, never the whole list per commit), and its calls are
// mapped forwards and their results back. A job goes from v1 to v2 too: a run started on v1 finishes on its old code,
// and the new `finish` gets its args and result mapped forwards.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/34-versions.ts
import { BACKGROUND_CONTEXT, type Context } from "../../../src/context/index.ts";
import {
	arr,
	evolve,
	hostKind,
	int,
	local,
	method,
	obj,
	remote,
	str,
	unknown,
} from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type FacetHost } from "../../../src/next/host/index.ts";
import { defineJob } from "../../../src/next/jobs/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type Principal = { readonly kind: "server" } | { readonly kind: "owner" };

const Server = hostKind("server");

// The shared contract, as every plugin bundles it: v1, then v2 where a note gained a tag.
const NotesV1 = remote("example.notes", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { editor: { state: { notes: arr(str()) }, methods: { add: method(obj({ text: str() }), int()) } } },
});
const NotesV2 = evolve(NotesV1, (e) =>
	e
		.state("editor", "notes", arr(obj({ text: str(), tag: str() })))
		.method("add", obj({ text: str(), tag: str() }), obj({ count: int() })),
);

const List = defineState("example.list", {
	schema: obj({ notes: arr(obj({ text: str(), tag: str() })) }),
	version: 1,
	initial: () => ({ notes: [] }),
});

/** The server's notes plugin at v2: what a v1 consumer sees is the provider's `accepts[1]`. */
function serveV2(host: FacetHost<Principal>): void {
	host.serve(
		NotesV2,
		(_, _principal, self) => {
			const list = self.state(List);
			return {
				variant: "editor",
				members: {
					notes: self.derive([list], ([value]) => value.notes),
					add: async ({ text, tag }, ctx) => {
						await list.change((draft) => void draft.notes.push({ text, tag }), ctx);
						return { count: list.value.notes.length };
					},
				},
			};
		},
		{
			accepts: {
				1: {
					state: { editor: { notes: (current) => current.map(({ text }) => text) } },
					methods: { add: { args: (old) => ({ ...old, tag: "untagged" }), result: (current) => current.count } },
				},
			},
		},
	);
}

/** The server's notes plugin at v1. */
function serveV1(host: FacetHost<Principal>): void {
	host.serve(NotesV1, (_, _principal, self) => {
		const list = self.state(List);
		return {
			variant: "editor",
			members: {
				notes: self.derive([list], ([value]) => value.notes.map(({ text }) => text)),
				add: async ({ text }, ctx) => {
					await list.change((draft) => void draft.notes.push({ text, tag: "" }), ctx);
					return list.value.notes.length;
				},
			},
		};
	});
}

// 1. A server on v1 and a tab built against v1, connected.
const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
await server.load([{ name: "@example/notes", facet: defineFacet<Principal>(serveV1) }], context);
const tab = createHost<Principal>({ onError: () => {} });
await tab.load([], context);
const [up, down] = memoryLinkPair();
server.accept(up, { principal: { kind: "owner" } }, context);
tab.connect(down, { principal: { kind: "server" } }, context);
const old = await tab.get(NotesV1, {}, context);
await old.add({ text: "milk" }, context);
const watch = await old.notes.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("   tab frame:", JSON.stringify(call.ops));
});
console.log("1. v1 everywhere:", old.notes.value);

// 2. The server reloads to v2 with `accepts[1]`: the old tab's hold is kept; its version is an older one now, so it is
// bound again through the mapping (one snapshot), and from then on gets the mapped diffs.
await server.reload([{ name: "@example/notes", facet: defineFacet<Principal>(serveV2) }], context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("2. server on v2; the old tab still reads", old.notes.value, "and its state:", old.state.value.kind);

// 3. The old tab calls v1's `add`: its args are mapped forwards, the v2 result mapped back to v1's count.
console.log("3. old add returned", await old.add({ text: "eggs" }, context));
await new Promise((resolve) => setTimeout(resolve, 10));
// A new tab (v2 code) on the same object sees the tags.
const fresh = await tab.get(NotesV2, {}, context);
console.log("   a v2 consumer reads", JSON.stringify(fresh.notes.value));

// 4. Jobs: `Export` v2 maps a v1 run's args and result forwards; a v1 run still running finishes on its old code.
const ExportV1 = defineJob("example.export", { version: 1, args: obj({ path: str() }), result: str() });
const ExportV2 = defineJob("example.export", {
	version: 2,
	args: obj({ path: str(), format: str() }),
	result: obj({ file: str() }),
	accepts: {
		1: { args: (old: { path: string }) => ({ ...old, format: "md" }), result: (old: string) => ({ file: old }) },
	},
});
const Exports = local("example.exports", {
	version: 1,
	params: {},
	members: { start: method(obj({ path: str() }), str()), running: arr(unknown()) },
});
let release: (() => void) | undefined;

/** The exports plugin with `job` (v1 or v2): its `run` waits for `release` once, its `finish` prints the outcome. */
function exportsPlugin(code: string, job: typeof ExportV1 | typeof ExportV2) {
	return defineFacet<Principal>((host) =>
		host.serve(Exports, (_, self) => {
			// One handle for either version of the job (the two definitions' types differ).
			const handle = (
				self.job as unknown as (
					definition: unknown,
					implementation: unknown,
				) => {
					start(args: unknown, ctx: Context): Promise<{ readonly id: string }>;
					readonly running: never;
				}
			)(job, {
				run: async (args: { path: string }) => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return job.version === 1 ? `${args.path}.md` : { file: `${args.path}.out` };
				},
				finish: (outcome: unknown) => console.log(`   finish on ${code}:`, JSON.stringify(outcome)),
			});
			return {
				start: async ({ path }: { path: string }, ctx: Context) =>
					(await handle.start(job.version === 1 ? { path } : { path, format: "html" }, ctx)).id,
				running: handle.running,
			};
		}),
	);
}

const worker = createHost<Principal>({ onError: () => {} });
await worker.load([{ name: "@example/exports", facet: exportsPlugin("v1 code", ExportV1) }], context);
const exportsRef = await worker.get(Exports, {}, context);
await exportsRef.start({ path: "notes" }, context);
await new Promise((resolve) => setTimeout(resolve, 0));
await worker.reload([{ name: "@example/exports", facet: exportsPlugin("v2 code", ExportV2) }], context);
console.log("4. after the reload, running shows the v1 run mapped:", JSON.stringify(exportsRef.running.value));
release?.();
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("   running is empty again:", JSON.stringify(exportsRef.running.value));

await worker.close(context);
await tab.close(context);
await server.close(context);
