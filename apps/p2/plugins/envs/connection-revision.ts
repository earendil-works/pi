// The revision a connection to an environment was opened for: its own configuration's, and for a sandbox also its
// host's (the connection goes through the host), so editing either starts a new connection.

import { envRevision } from "@p2/app/v1/node";
import type { EnvConfig, EnvsConfig } from "./schema.ts";

/** The connection revision of an environment configured as `config`, under `configs` (where a sandbox finds its host). */
export function connectionRevision(configs: EnvsConfig, config: EnvConfig): string {
	if (config.type === "ssh") return envRevision(config);
	const host = Object.hasOwn(configs, config.host) ? configs[config.host] : undefined;
	return `${envRevision(config)}+${host === undefined ? "" : envRevision(host)}`;
}
