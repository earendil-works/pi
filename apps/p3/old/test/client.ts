// A client of a running p3 over WebSocket, signed in as the owner with the owner token file, as a command-line client
// on the same machine signs in: for the end-to-end tests and the benchmarks.

import { readFile } from "node:fs/promises";
import { createHost, type Host, webSocketLink } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";

/** What a client needs of a running p3, in this process or launched: its owner link (for the port) and token file. */
export type Reachable = { ownerLink(): string; readonly ownerTokenFile: string };

/** A client host of `server`, connected over WebSocket with the owner's bearer token and loaded with no plugins. */
export async function ownerClient(server: Reachable, context: Context): Promise<Host<P3Principal>> {
	const { port } = new URL(server.ownerLink());
	const token = (await readFile(server.ownerTokenFile, "utf8")).trim();
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols, hence the cast.
	const init = { headers: { authorization: `Bearer ${token}` } } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	// A worker that fails its start fails a test in seconds, not after a minute.
	const client = createHost<P3Principal>({ readyTimeout: 5000, onError: (error) => console.error("client:", error) });
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}
