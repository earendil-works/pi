// The user's theme choice (slice 11 §4b): one dark and one light theme id per principal, kept by the server (the kit
// serves it) and held by every page and terminal of that principal, so choosing a theme restyles them all at once.
// Bounded (fix round 1: Opus M4, Fable L7): an id is at most 128 characters, and the store keeps the picks of the
// `MAX_PICKS` principals who chose last (a public app's guests choose too).

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { hostKind, local, map, method, nul, obj, remote, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { principalKey } from "../data/principal.ts";
import { defineState } from "../documents/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import type { ThemePick } from "./themes.ts";

/** A theme id (at most 128 characters), or `null` for the first contributed theme of its mode. */
const ThemeId = union([str({ max: 128 }), nul()]);

/** A pick: a theme id per mode. */
const Pick = obj({ dark: ThemeId, light: ThemeId });

/** How many principals' picks the store keeps: past it the earliest chooser's goes (they see the first theme). */
const MAX_PICKS = 10_000;

/** The caller's theme choice, on the server: its pick, and `choose` to change it. */
export const ThemeChoice = remote("chord.themes.choice", {
	version: 1,
	params: {},
	hostAddress: () => hostKind("server")(),
	variants: { main: { state: { pick: Pick }, methods: { choose: method(Pick) } } },
});

/** Every principal's pick, by principal key: one document of the server's store. */
const Picks = defineState("chord.themes.picks", {
	schema: obj({ picks: map(Pick) }),
	version: 1,
	initial: () => ({ picks: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** The server's keeper of every pick (a persisted state needs a local type with empty params). */
const PickStore = local("chord.themes.picks", {
	version: 1,
	params: {},
	members: { picks: map(Pick), set: method(obj({ key: str(), pick: Pick })) },
});

/** No choice yet: the first contributed theme of each mode. */
const NO_PICK: ThemePick = { dark: null, light: null };

/** The kit's server facet for theme choices: the store of picks and each principal's `ThemeChoice`. */
export function themeChoiceFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => {
		host.serve(PickStore, (_params, self) => {
			const picks = self.state(Picks);
			return {
				picks: self.derive([picks], ([value]) => value.picks),
				set: async ({ key, pick }, ctx) => {
					await picks.change((draft) => {
						// Re-added last: the keys keep the order of choosing, the first the earliest.
						delete draft.picks[key];
						draft.picks[key] = pick;
						const keys = Object.keys(draft.picks);
						for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete draft.picks[old];
					}, ctx);
					return null;
				},
			};
		});
		host.serve(ThemeChoice, (_params, principal, self) => {
			const store = self.get(PickStore, {});
			const key = principalKey(principal, BACKGROUND_CONTEXT);
			return {
				variant: "main",
				members: {
					// A key that is a principal's canonical JSON: `Object.hasOwn`, no inherited member is a pick.
					pick: self.derive([store.picks], ([picks]) => (Object.hasOwn(picks, key) ? picks[key]! : NO_PICK)),
					choose: (pick, ctx) => store.set({ key, pick }, ctx),
				},
			};
		});
	});
}
