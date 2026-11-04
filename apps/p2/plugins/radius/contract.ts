import { defineRegistry, local } from "@p2/app/v1";
import type { RadiusBrain } from "./brain.ts";
import type { RelayAccess } from "./relay-access.ts";

/** The Radius connection (server, host-internal); its relay credentials never leave the `RadiusConnections` native. */
export const RadiusService = local("p2.radius-service", { version: 2, params: {}, members: {} });

/** The open `RadiusService`'s relay and brain: read `.connection` at each use. */
export type RadiusConnection = { readonly relay: RelayAccess; readonly brain: RadiusBrain };
export const RadiusConnections = defineRegistry<
	{ readonly connection: RadiusConnection },
	{ readonly connection: RadiusConnection } | undefined
>("p2.radius-connections", { version: 1 });
