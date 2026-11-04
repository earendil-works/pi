// A user's preference kept by the server (slice 11 §4b; decision "Messages and languages in the app kit" (3)): one pick
// per principal, kept by the kit's server and held by every page and terminal of that principal, so choosing restyles
// or re-renders them all at once. The theme choice and the locale choice are two of them. Bounded (fix round 1: Opus
// M4, Fable L7): the store keeps the picks of the `MAX_PICKS` principals who chose last (a public app's guests choose
// too).

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { hostKind, local, map, method, obj, remote, type Schema, str } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { principalKey } from "../data/principal.ts";
import { defineState } from "../documents/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import type { JsonValue } from "../json.ts";

/** A preference's contract as its facet serves it: the caller's `pick` (JSON) and `choose`, remote on the server. */
export type PreferenceContract = ReturnType<typeof preferenceContract<string, JsonValue>>;

/** A preference's remote contract `name`: the caller's pick on the server (`pick`), and `choose` to change it. */
export function preferenceContract<const N extends string, T>(name: N, pick: Schema<T>) {
	return remote(name, {
		version: 1,
		params: {},
		hostAddress: () => hostKind("server")(),
		variants: { main: { state: { pick }, methods: { choose: method(pick) } } },
	});
}

/** How many principals' picks a store keeps: past it the earliest chooser's goes (they get the preference's none). */
const MAX_PICKS = 10_000;

/**
 * The kit's server facet of the preference `Choice`: every principal's pick in one persisted document of the store
 * `store` by principal key, and each principal's `Choice` (`none` before a choice).
 */
export function preferenceFacet<P extends Principal>(
	Choice: PreferenceContract,
	store: string,
	pick: Schema<JsonValue>,
	none: JsonValue,
): Facet<P> {
	const Picks = defineState(store, {
		schema: obj({ picks: map(pick) }),
		version: 1,
		initial: () => ({ picks: {} }),
		persist: true,
		checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
	});
	// A persisted state needs a local type with empty params.
	const PickStore = local(store, {
		version: 1,
		params: {},
		members: { picks: map(pick), set: method(obj({ key: str(), pick })) },
	});
	return defineFacet<P>((host) => {
		host.serve(PickStore, (_params, self) => {
			const picks = self.state(Picks);
			return {
				picks: self.derive([picks], ([value]) => value.picks),
				set: async ({ key, pick: next }, ctx) => {
					await picks.change((draft) => {
						// Re-added last: the keys keep the order of choosing, the first the earliest.
						delete draft.picks[key];
						draft.picks[key] = next;
						const keys = Object.keys(draft.picks);
						for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete draft.picks[old];
					}, ctx);
					return null;
				},
			};
		});
		host.serve(Choice, (_params, principal, self) => {
			const picks = self.get(PickStore, {});
			const key = principalKey(principal, BACKGROUND_CONTEXT);
			return {
				variant: "main",
				members: {
					// A key that is a principal's canonical JSON: `Object.hasOwn`, no inherited member is a pick.
					pick: self.derive([picks.picks], ([all]) => (Object.hasOwn(all, key) ? all[key]! : none)),
					choose: (next, ctx) => picks.set({ key, pick: next }, ctx),
				},
			};
		});
	});
}
