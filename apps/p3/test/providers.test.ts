// The worker's built-in providers loaded on first use (`src/api/v1/providers.ts`): the table names every built-in
// provider pi-ai has, under its own id, and an id loads its provider; an unknown id loads nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builtinProviders } from "@earendil-works/p3/v1/server";
import { loadProvider } from "@earendil-works/p3/v1/worker";

describe("loadProvider", () => {
	it("loads every built-in provider by its id, and nothing for an unknown one", async () => {
		for (const { id } of builtinProviders()) {
			const loaded = await loadProvider(id);
			assert.equal(loaded?.id, id, id);
		}
		assert.equal(await loadProvider("nobody"), undefined);
		assert.equal(await loadProvider("constructor"), undefined);
	});
});
