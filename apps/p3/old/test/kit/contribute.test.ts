// Tests of `contribute`: an object that only contributes, with what a facet's own `self.contribute` cannot use.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { constant, contribute, defineFacet, defineRegistry, local, type P3Principal, str } from "@earendil-works/p3/v1";

/** A registry of greetings, composed into one list. */
const Greetings = defineRegistry<string, readonly string[]>("test.greetings", { version: 1 });

const Names = local("test.names", { version: 1, params: {}, members: { name: str() } });

const facet = defineFacet((host) => {
	host.serve(Greetings, { compose: (table) => table.map(({ value }) => value) });
	host.serve(Names, () => ({ name: constant("Pi") }));
	// The contribution follows another object's state: it needs a reference, so it needs an object.
	contribute(host, "test.greeter", (self) => {
		const names = self.get(Names, {});
		self.contribute(
			Greetings,
			self.derive([names.name], ([name]) => `hello ${name}`),
		);
	});
});

describe("contribute", () => {
	it("contributes from a host-lifetime object with no members", async () => {
		const host = createHost<P3Principal>({ onError: () => {} });
		await host.load([{ name: "@test/contribute", facet }], context);
		const greetings = await host.registry(Greetings, context);
		assert.deepEqual(greetings.value, ["hello Pi"]);
		await host.close(context);
	});
});
