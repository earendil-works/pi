// The users plugin (slice 13 §3, decision "The app kit, point 2: principals and users"): accounts keyed by the user's
// id with a profile the app describes (a schema it passes in: a Slack-like profile or just a name), kept in the
// server's store. User data never rides in the principal: a principal names the user, `Users` holds the rest.
// An exported facet, not a plugin directory: it takes the app's schema as an argument (settings are arguments), and a
// plugin directory could not import it (plugins import only the app's API). The app loads it in its root by
// re-exporting it through its API (`export const users = defineUsers(Profile)` in `/v3/server`, a one-line plugin).

import type { JsonValue } from "../../json.ts";
import { arr, local, map, method, nul, obj, type Schema, str, union } from "../../next/contracts/index.ts";
import type { Principal } from "../../next/data/index.ts";
import { invalid } from "../../next/data/internal.ts";
import { defineState } from "../../next/documents/index.ts";
import { defineFacet, type Facet } from "../../next/host/index.ts";

/** The users plugin for profiles of schema `profile`: its contract and the facet serving it on the server. */
export function defineUsers<T extends JsonValue, P extends Principal = Principal>(profile: Schema<T>) {
	const Users = local("chord.app.users", {
		version: 1,
		params: {},
		members: {
			/** Every user: id and profile. */
			list: arr(obj({ id: str(), profile })),
			/** The profile of user `id`, or `null`. */
			get: method(str(), union([profile, nul()])),
			/** Sets the profile of user `id` (a new user: an account made). */
			update: method(obj({ id: str(), profile })),
			/** Removes user `id`'s account. */
			remove: method(str()),
		},
	});
	// Stored as JSON: the document's types cannot follow a generic profile, the contract's members do.
	const stored = profile as Schema<JsonValue>;
	const Accounts = defineState("chord.app.users", {
		schema: obj({ users: map(stored) }),
		version: 1,
		initial: () => ({ users: {} }),
		persist: true,
		checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
	});
	const facet: Facet<P> = defineFacet<P>((host) =>
		host.serve(Users, (_params, self) => {
			const accounts = self.state(Accounts);
			return {
				list: self.derive([accounts], ([value]) =>
					Object.entries(value.users).map(([id, each]) => ({ id, profile: each as T })),
				),
				// A trust boundary: `id` is the caller's (`Object.hasOwn`: no inherited member is a user). Written by
				// `update` from a `T`.
				get: async (id) => (Object.hasOwn(accounts.value.users, id) ? (accounts.value.users[id] as T) : null),
				update: async ({ id, profile: next }, ctx) => {
					// As a key it would set the record's prototype, not add a user.
					if (id === "__proto__") throw invalid("args", "users: __proto__ is no user id");
					await accounts.change((draft) => {
						draft.users[id] = next as JsonValue;
					}, ctx);
					return null;
				},
				remove: async (id, ctx) => {
					await accounts.change((draft) => {
						delete draft.users[id];
					}, ctx);
					return null;
				},
			};
		}),
	);
	return { Users, facet };
}
