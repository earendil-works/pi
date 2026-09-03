import { join } from "node:path";

/** Derive the local Unix socket path for one logical server identity. */
export function getUnixSocketPath(serverId: string, serverDirectory: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(serverId)) {
		throw new TypeError("Unix serverId must be a canonical lowercase UUIDv4");
	}
	return join(serverDirectory, `${serverId}.sock`);
}
