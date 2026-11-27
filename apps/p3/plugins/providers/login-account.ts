// One login's account models on the server (`LoginAccount { thing }`): its provider and the chat models of its
// account, its type's catalog (the stored one laid over the shipped models, `catalog.ts`) cut to the ids its account
// has (the login's row). Read by the login's object (its `login`) and by every `SessionModels` whose agent may Use
// it; its two live reads, the login's row and its type's catalog, are the same for every holder.

import type { FacetHost, JsonValue, P3Principal, Watchable } from "@earendil-works/p3/v1";
import { typeModels } from "./catalog.ts";
import { type AccountModels, CatalogStore, LoginAccount, LoginStore } from "./contract.server.ts";
import { LoginProviders } from "./login-providers.ts";

/** Serves `LoginAccount` on `host`. */
export function serveLoginAccount(host: FacetHost<P3Principal>): void {
	host.serve(LoginAccount, ({ thing }, self) => {
		const providers = self.registry(LoginProviders);
		const row = self.liveQuery(self.get(LoginStore, {}).logins.one, { thing }, { first: 1 });
		// Its type's stored catalog (none to read while its row is not there).
		const provider = self.derive([row], ([{ rows }]) => ({ provider: rows[0]?.provider ?? "" }));
		const catalog = self.liveQuery(self.get(CatalogStore, {}).catalogs.one, provider, { first: 1 });
		const account = self.derive([row, providers, catalog], ([{ rows }, offered, entries]): JsonValue => {
			const found = rows[0];
			const type = found === undefined ? undefined : offered.get(found.provider)?.value;
			if (found === undefined || type === undefined) return null;
			const all = typeModels(type, entries.rows[0]?.entry);
			const { models: has } = found;
			// pi-ai's definitions are plain data: JSON.
			const models = (has === null ? all : all.filter(({ id }) => has.includes(id))) as unknown as JsonValue[];
			const value: AccountModels = { provider: found.provider, providerName: type.name, models };
			return value as unknown as JsonValue;
		});
		// pi-ai's definitions are JSON (`unknown` in the schema, `JsonValue` in a derive): the same value.
		return { account: account as unknown as Watchable<AccountModels | null> };
	});
}
