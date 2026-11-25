// The server's name for the owner's Settings (browser-safe contract): what this p2 calls itself, the device's name it
// falls back to, and a rename. The server host serves it from its `ServerName` (src/runtime/server.ts).

import { method, remote } from "@earendil-works/chord";
import { nul, obj, str, union } from "@earendil-works/pi-schema";
import { serverHost } from "./chord.ts";

/**
 * Longest server name, in characters, as Radius stores it (`MAX_SERVER_NAME_LENGTH`): a DNS label (63), so a host
 * name is never cut. Linux 64, Windows 15, Kubernetes and cloud VMs 63; only a macOS computer name can be longer.
 */
export const MAX_SERVER_NAME_LENGTH = 63;

const Name = union([str(), nul()]);

/** The server's name as the owner sees and changes it (owner only). */
export const ServerNameSettings = remote("p2.server-name-settings", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				/** What the server calls itself: `chosen`, else `device`; null when neither has one. */
				name: Name,
				/** The name the owner gave it; null: none, the device's name stands. */
				chosen: Name,
				/** The device's name as of the server's start; null when the device has none. */
				device: Name,
			},
			methods: {
				/**
				 * Names the server `name` (normalized to one line of at most MAX_SERVER_NAME_LENGTH characters), or, for null
				 * or a name that normalizes to nothing, back to the device's name. Answers once saved.
				 */
				rename: method(obj({ name: union([str({ maxLength: 1024 }), nul()]) })),
			},
		},
	},
});
