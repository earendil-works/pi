// Tests of scripts that register themselves (slice 11 §1, §2): the served text calls `chordFacet` with the plugin, the
// digest and the build's function; evaluating it answers only the client's modules (an ES module namespace as a
// CommonJS import sees it) and refuses a default export that is no facet.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import * as chordNext from "../../src/index.ts";
import {
	evaluateRegistered,
	type FacetFunction,
	REGISTER,
	type RegisteredScript,
	registeredSource,
} from "../../src/surfaces/registered.ts";

/** Runs a registered script's text and returns what it registered. */
function run(text: string): RegisteredScript[] {
	const registered: RegisteredScript[] = [];
	(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, f: FacetFunction) =>
		registered.push({ plugin, digest, run: f });
	new Script(text).runInThisContext();
	delete (globalThis as Record<string, unknown>)[REGISTER];
	return registered;
}

/** A built script's function expression, as esbuild wraps a facet: it requires `specifier`, exports a facet. */
const BUILT = (specifier: string) =>
	`(function (require, module, exports) {
const chord = require(${JSON.stringify(specifier)});
module.exports = { default: chord.defineFacet(() => {}) };
//# sourceMappingURL=data:application/json;base64,e30=
})`;

describe("registered scripts", () => {
	it("register their plugin, digest and function, the source map comment kept inside the call", () => {
		const text = registeredSource("@acme/notes", "abc123", BUILT("@acme/app/v1"));
		expect(text.startsWith('chordFacet("@acme/notes","abc123",(function (require, module, exports) {')).toBe(true);
		const [script] = run(text);
		expect([script!.plugin, script!.digest]).toEqual(["@acme/notes", "abc123"]);
		const facet = evaluateRegistered(script!, { "@acme/app/v1": chordNext });
		expect(typeof facet.setup).toBe("function");
	});

	it("answer only the client's modules, naming the plugin", () => {
		const [script] = run(registeredSource("@acme/notes", "d", BUILT("node:fs")));
		expect(() => evaluateRegistered(script!, { "@acme/app/v1": chordNext })).toThrow(
			'plugin "@acme/notes": "node:fs" is not one of this client\'s host packages',
		);
	});

	it("refuse a default export that is no facet", () => {
		const [script] = run(
			registeredSource("@acme/bad", "d", "(function (require, module) { module.exports = { default: 42 }; })"),
		);
		expect(() => evaluateRegistered(script!, {})).toThrow('plugin "@acme/bad": its default export is not a facet');
	});
});
