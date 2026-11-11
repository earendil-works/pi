// The owner's settings.json editor: the settings as the server holds them, and a change of some of them.
import { arr, nul, obj, str, union, unknown } from "@earendil-works/pi-schema";
import { method, remote, serverHost, unsafe } from "@p2/app/v1";
import type { MobileSettings } from "@p2/app/v1/node";

export type { MobileSettings } from "@p2/app/v1/node";

/** settings.json for the Settings sheet (owner only); the file stays the source, saved through the models plugin. */
export const Settings = remote("p2.settings", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				/** The last valid settings.json (the server keeps it while the file is invalid). */
				settings: unsafe<MobileSettings>(unknown()),
				/** Why settings.json could not be loaded; absent while it is valid. */
				error: union([str(), nul()]),
			},
			methods: {
				/**
				 * Sets the top-level settings in `set` (a partial settings.json, each value whole) and removes the ones in
				 * `unset` (back to their defaults); the other settings stay as the file has them now. The answer comes
				 * after the server reloaded the file.
				 */
				update: method(obj({ set: unknown(), unset: arr(str({ maxLength: 64 }), { maxItems: 64 }) })),
			},
		},
	},
});
