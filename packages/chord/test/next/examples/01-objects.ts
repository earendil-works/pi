// Objects on one host: a contract, a facet serving it, references, calls, and how long objects live.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/01-objects.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

// Every call takes a context, used for cancellation; BACKGROUND_CONTEXT is never cancelled.
const context = BACKGROUND_CONTEXT;

// A contract declares what an object type offers: state members (schemas) and methods (arguments, result).
// `params` select the instance: one object per params value.
const Greeter = local("example.greeter", {
	version: 1,
	params: { language: str() },
	members: { language: str(), greet: method(obj({ name: str() }), str()) },
});
// Empty params: one object for the whole host.
const Clock = local("example.clock", { version: 1, params: {}, members: { started: int() } });

// A facet is a plugin's setup for one host. It serves types with factories; a factory only declares and returns the
// implementation: a watchable per state member, an async function per method.
const facet = defineFacet((host) => {
	host.serve(Clock, () => {
		console.log("clock: created at load");
		return { started: constant(Date.now()) };
	});
	host.serve(Greeter, ({ language }) => {
		console.log(`greeter ${language}: created by its first get`);
		return {
			language: constant(language),
			greet: async ({ name }) => (language === "de" ? `Hallo ${name}` : `Hello ${name}`),
		};
	});
});

// onError receives background errors, such as a watch listener that throws.
const host = createHost({ onError: (error) => console.error("background error:", error) });
// load runs every setup and activates the types with empty params before it resolves.
await host.load([{ name: "@example/greeter", facet }], context);

// A reference is live once its get resolves: its state members have values, its methods can be called.
const german = await host.get(Greeter, { language: "de" }, context);
console.log("language:", german.language.value);
console.log("greet:", await german.greet({ name: "Mario" }, context));

// Arguments are checked against the contract at the object.
try {
	// @ts-expect-error: `name` must be a string
	await german.greet({ name: 42 }, context);
} catch (error) {
	if (isChordError(error, "invalid")) console.log("refused:", error.reason, error.message);
}

// The same params share one object; releasing the last reference ends it.
const again = await host.get(Greeter, { language: "de" }, context);
german.release();
again.release();
try {
	german.language.value;
} catch (error) {
	if (isChordError(error, "released")) console.log("after release:", error.message);
}

// close ends every object.
await host.close(context);
