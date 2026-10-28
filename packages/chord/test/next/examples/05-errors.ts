// Errors: what Chord refuses and how a caller tells the cases apart (`ChordError` with `code` and `reason`).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/05-errors.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

/** Prints how `work` failed: a ChordError's code, reason and message, or a plain error's message. */
async function attempt(label: string, work: () => unknown): Promise<void> {
	try {
		await work();
		console.log(`${label}: ok`);
	} catch (error) {
		if (isChordError(error))
			console.log(`${label}: ${error.code}${error.reason ? `/${error.reason}` : ""} - ${error.message}`);
		else console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const Echo = local("example.echo", {
	version: 1,
	params: { id: int() },
	members: { id: int(), echo: method(obj({ text: str() }), str()) },
});
// Two types that get each other while they activate: a cycle.
const Ping = local("example.ping", { version: 1, params: {}, members: { n: int() } });
const Pong = local("example.pong", { version: 1, params: {}, members: { n: int() } });
const Broken = local("example.broken", { version: 1, params: { id: int() }, members: { n: int() } });
const Sloppy = local("example.sloppy", { version: 1, params: { id: int() }, members: { n: int() } });

const facet = defineFacet((host) => {
	host.serve(Echo, ({ id }) => ({ id: constant(id), echo: async ({ text }) => text }));
	host.serve(Broken, () => {
		throw new Error("broken: missing configuration");
	});
	// Plugins are bundled without type checks; Chord checks the implementation's members when the object activates.
	host.serve(Sloppy, () => ({ n: constant(1), extra: constant(2) }) as never);
});
// Ping and Pong are served by a second plugin: types with empty params activate at load.
const cycle = defineFacet((host) => {
	host.serve(Ping, (_, self) => ({ n: self.get(Pong, {}).n }));
	host.serve(Pong, (_, self) => ({ n: self.get(Ping, {}).n }));
});

// Failed activations are reported to onError; 07-failures.ts shows the other reports.
const onError = (error: HostError): void => {
	if (error.kind === "activation_failed") console.log(`reported: ${error.object} failed ${error.failure.kind}`);
	else console.log("reported:", error.kind);
};

// A dependency cycle fails every object on it broken, with invalid/cycle naming the chain. Load still resolves: the
// start barrier waits for each object's first outcome, live or failed.
const host = createHost({ onError });
await host.load(
	[
		{ name: "@example/errors", facet },
		{ name: "@example/cycle", facet: cycle },
	],
	context,
);
await attempt("get in a cycle", () => host.get(Ping, {}, context));
const echo = await host.get(Echo, { id: 1 }, context);

// Arguments are checked against the contract at the object: wrong types and unknown fields are invalid/args.
// @ts-expect-error: text must be a string
await attempt("wrong argument", () => echo.echo({ text: 1 }, context));
// @ts-expect-error: an unknown field
await attempt("unknown field", () => echo.echo({ text: "hi", extra: true }, context));

// Params select the object and are checked on every get: invalid/params.
// @ts-expect-error: id must be an integer
await attempt("bad params", () => host.get(Echo, { id: "one" }, context));

// An implementation with a member its contract does not declare fails activation.
await attempt("unknown member", () => host.get(Sloppy, { id: 1 }, context));

// A get needs the provider's version and fingerprint; another declaration of the type does not fit.
const EchoV2 = local("example.echo", { version: 2, params: { id: int() }, members: { id: int() } });
await attempt("contract mismatch", () => host.get(EchoV2, { id: 1 }, context));

// A factory that throws fails broken: the get rejects at once with its error, and no object is left behind.
await attempt("throwing factory", () => host.get(Broken, { id: 1 }, context));

// After release, every use of a reference throws released.
echo.release();
await attempt("released reference", () => echo.echo({ text: "hi" }, context));

await host.close(context);
await attempt("get after close", () => host.get(Echo, { id: 1 }, context));
