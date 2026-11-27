// The model settings things' overrides on the server (`ModelSettingsStore`): one row per thing, its overrides as a
// whole, set by the kind's `set` and `configure` alike, removed with the thing; read by the thing's object and by
// every `SessionModels` the thing reaches. This plugin's own server code only: it checks no caller.

import { arr, defineTable, eq, type FacetHost, json, type P3Principal, query, str } from "@earendil-works/p3/v1";
import { ModelSettingsStore } from "./contract.server.ts";
import { ModelOverride } from "./contract.ts";

/** Every model settings thing's overrides, by its id. */
const Settings = defineTable("providers.model-settings", {
	version: 1,
	columns: { thing: str(), overrides: json(arr(ModelOverride), { version: 1 }) },
	key: ["thing"],
});

/** Serves `ModelSettingsStore` on `host`. */
export function serveModelSettingsStore(host: FacetHost<P3Principal>): void {
	host.serve(ModelSettingsStore, (_params, self) => {
		const settings = self.table(Settings);
		return {
			settings: self.queries(
				settings,
				{ map: ({ thing, overrides }) => ({ thing, overrides }), reads: ["thing", "overrides"] },
				// The key.
				{ one: ({ thing }: { thing: string }) => query(Settings).where((row) => eq(row.thing, thing)) },
			),
			set: ({ thing, overrides }, ctx) =>
				self.tx(async (tx) => {
					tx.put(settings, { thing, overrides });
					return null;
				}, ctx),
			clear: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(settings, { thing });
					return null;
				}, ctx),
		};
	});
}
