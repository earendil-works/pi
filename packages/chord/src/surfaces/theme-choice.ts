// The user's theme choice (slice 11 §4b): one dark and one light theme id per principal, a preference the server keeps
// (the kit serves it) and every page and terminal of that principal holds, so choosing a theme restyles them all at
// once. An id is at most 128 characters (fix round 1: Opus M4, Fable L7).

import { nul, obj, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";
import { preferenceContract, preferenceFacet } from "./preference.ts";
import type { ThemePick } from "./themes.ts";

/** A theme id (at most 128 characters), or `null` for the first contributed theme of its mode. */
const ThemeId = union([str({ max: 128 }), nul()]);

/** A pick: a theme id per mode. */
const Pick = obj({ dark: ThemeId, light: ThemeId });

/** The caller's theme choice, on the server: its pick, and `choose` to change it. */
export const ThemeChoice = preferenceContract("chord.themes.choice", Pick);

/** No choice yet: the first contributed theme of each mode. */
const NO_PICK: ThemePick = { dark: null, light: null };

/** The kit's server facet for theme choices: the store of picks and each principal's `ThemeChoice`. */
export function themeChoiceFacet<P extends Principal>(): Facet<P> {
	return preferenceFacet<P>(ThemeChoice, "chord.themes.picks", Pick, NO_PICK);
}
