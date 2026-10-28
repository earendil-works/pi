// Calls over a link: results, bytes as raw segments, ChordErrors and plugin errors, the caller's principal and
// incarnation in `ctx`, cancellation, and release rejecting the calls made through a reference.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/09-calls.ts
import { BACKGROUND_CONTEXT, withCancel } from "../../../src/context/index.ts";
import { bytes, int, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { isChordError, PluginError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" };

const Files = remote("example.files", {
	version: 1,
	params: {},
	variants: {
		owner: {
			methods: {
				whoami: method(undefined, str()),
				// A `bytes()` leaf: the argument and result travel as raw segments, never base64.
				upload: method(obj({ name: str(), data: bytes() }), int()),
				download: method(obj({ name: str() }), bytes()),
				quota: method(),
				slow: method(),
			},
		},
	},
});

const stored = new Map<string, Uint8Array>();

const facet = defineFacet<P>((host) => {
	host.serve(Files, () => ({
		variant: "owner",
		members: {
			// ctx.principal is the caller as its link stamped it; ctx.incarnation the calling host's run (R20).
			whoami: async (ctx) => `${ctx.principal?.kind} from ${ctx.incarnation.slice(0, 8)}…`,
			upload: async ({ name, data }) => {
				stored.set(name, data);
				return data.byteLength;
			},
			download: async ({ name }) => stored.get(name) ?? new Uint8Array(),
			// A PluginError crosses with its code, message and details; any other throw as code `internal`.
			quota: async () => {
				throw new PluginError("quota", "the store is full", { limit: 1 });
			},
			// A handler's context is aborted when its caller cancels or releases the reference.
			slow: (ctx) =>
				new Promise((resolve) =>
					ctx.abortSignal?.addEventListener("abort", () => {
						console.log("server: slow aborted:", (ctx.abortSignal?.reason as Error).message);
						resolve(null);
					}),
				),
		},
	}));
});

const server = createHost<P>({ principal: { kind: "server" }, onError: (error) => console.error("server:", error) });
await server.load([{ name: "@example/files", facet }], context);
const [up, down] = memoryLinkPair();
server.accept(up, { principal: { kind: "owner" } }, context);
const client = createHost<P>({ onError: (error) => console.error("client:", error) });
client.connect(down, { principal: { kind: "server" } }, context);
await client.load([], context);

const files = await client.get(Files, {}, context);

// 1. A call resolves with its result; a method without arguments takes only the context.
console.log("whoami:", await files.whoami(context));

// 2. Bytes: 1 MiB goes out as one raw segment next to the JSON part.
const data = new Uint8Array(1024 * 1024).fill(7);
console.log("uploaded bytes:", await files.upload({ name: "chart.png", data }, context));
const back = await files.download({ name: "chart.png" }, context);
console.log("downloaded:", back.byteLength, "bytes, a", back.constructor.name);

// 3. Errors: arguments are checked at the provider (a ChordError); a plugin's own error keeps its code.
try {
	// @ts-expect-error: `name` must be a string
	await files.upload({ name: 1, data }, context);
} catch (error) {
	if (isChordError(error, "invalid")) console.log("refused:", error.reason, error.message);
}
try {
	await files.quota(context);
} catch (error) {
	if (error instanceof PluginError) console.log("plugin error:", error.code, error.message, error.details);
}

// 4. Cancellation: the caller is rejected at once, the provider aborts the handler.
const { context: cancellable, cancel } = withCancel(context);
const slow = files.slow(cancellable);
setTimeout(() => cancel(new Error("the user gave up")), 5);
await slow.catch((error: unknown) => console.log("client: slow rejected:", (error as Error).message));

// 5. Release rejects the calls made through the reference; the provider aborts their handlers.
const pending = files.slow(context);
await new Promise((resolve) => setTimeout(resolve, 5));
files.release();
await pending.catch((error: unknown) => console.log("client: pending call:", (error as Error).message));
await new Promise((resolve) => setTimeout(resolve, 5));

await client.close(context);
await server.close(context);
