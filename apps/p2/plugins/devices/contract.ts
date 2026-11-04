import { bool, obj, str } from "@earendil-works/pi-schema";
import { defineRegistry, local, method, remote, serverHost } from "@p2/app/v1";
import type { OwnerAccess } from "./owner-access.ts";

/**
 * Installation-owned key and one-time tokens (open while held; its access is the `DeviceAccesses` native). Neither
 * the key nor the cookie ever enters web state.
 */
export const DeviceAccess = local("p2.device-access", { version: 2, params: {}, members: {} });

/** The open `DeviceAccess`'s owner access: read `.access` at each use. */
export const DeviceAccesses = defineRegistry<
	{ readonly access: OwnerAccess },
	{ readonly access: OwnerAccess } | undefined
>("p2.device-accesses", { version: 1 });

/** All owners may open Devices; only the localhost device owner may mint an association token. */
export const Devices = remote("p2.devices", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { canMint: bool() },
			methods: { token: method(undefined, obj({ token: str() })) },
		},
	},
});
