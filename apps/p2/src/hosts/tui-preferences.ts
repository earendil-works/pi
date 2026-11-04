import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineFacet, type Facet, forbidden } from "../runtime/chord.ts";
import { isGuest, isOwner } from "../runtime/principals.ts";
import { TuiPreferences } from "../runtime/tui-preferences.ts";
import { MAX_PREFERENCE_FILE, sanitizeServerPreferences } from "../tui/preferences.ts";

/**
 * Optional server defaults for every TUI visitor (`<P2_DATA_DIR>/tui.json`): keybindings, a theme setting and display
 * settings, below each visitor's own launcher preferences (section 4.2). Never privileged bindings, credentials or
 * environment; unknown and invalid entries are dropped.
 */
export const tuiPreferencesFacet = (dataDir: string): Facet =>
	defineFacet((host) =>
		host.serve(TuiPreferences, (_params, principal) => {
			if (!isOwner(principal) && !isGuest(principal)) throw forbidden("owners and guests only");
			return {
				variant: "viewer",
				members: {
					read: async () => {
						let configured: unknown;
						try {
							const text = await readFile(join(dataDir, "tui.json"), "utf8");
							if (text.length > MAX_PREFERENCE_FILE) throw new Error("tui.json exceeds 256 KiB");
							configured = JSON.parse(text);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
						return sanitizeServerPreferences(configured);
					},
				},
			};
		}),
	);
