// The user's locale choice (decision "Messages and languages in the app kit" (3)): one locale per principal, a
// preference the server keeps (the kit serves it) and every page and terminal of that principal holds, so choosing a
// language re-renders them all at once, without a reload. `null` until the user chooses: the device's languages decide.

import { nul, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";
import { preferenceContract, preferenceFacet } from "./preference.ts";

/** A language tag (`de`, `pt-BR`; at most 35 characters, BCP 47's practical bound), or `null`: the device's. */
const Pick = union([str({ max: 35, pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$" }), nul()]);

/** The caller's locale choice, on the server: its pick, and `choose` to change it. */
export const LocaleChoice = preferenceContract("chord.locale.choice", Pick);

/** The kit's server facet for locale choices: the store of picks and each principal's `LocaleChoice`. */
export function localeChoiceFacet<P extends Principal>(): Facet<P> {
	return preferenceFacet<P>(LocaleChoice, "chord.locale.picks", Pick, null);
}
