// The owner's `Discord` as the page holds it from its start (`DiscordSheets`, always mounted for owners): the plugin's
// sheets read it here, so Settings › Discord and a session's link sheet show at once instead of holding it anew (a
// round trip each time one opens). Its state is small: the bots and the sessions' links.
import type { Held } from "@p2/app/v1";
import { createContext, useContext } from "react";
import type { Discord } from "./contract.ts";

/** The held `Discord` (undefined for guests and before the page holds it). */
export const HeldDiscord = createContext<Held<typeof Discord> | undefined>(undefined);

/** The owner's `Discord` as the page holds it. */
export function useDiscord(): Held<typeof Discord> | undefined {
	return useContext(HeldDiscord);
}
