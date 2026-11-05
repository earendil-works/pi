// The MCP servers' OAuth credentials, `<P2_DATA_DIR>/mcp-auth.json` (private, 0600): per server, by name and URL as in
// pi, the registered client, the tokens and a pending sign-in's PKCE verifier. Only the server's manager reads and
// writes it; tokens never leave the server.

import { join } from "node:path";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import type { McpOAuthServerStore, McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { LockedFile, stripBom } from "@p2/app/v1/node";

/** The stored states by server key. */
type States = Record<string, McpOAuthState>;

/** The credential file and the refresh locks of its servers. */
export class McpCredentials {
	readonly #file: LockedFile;
	/** The refresh running per server key: one p2 server per data directory, so a lock in this process suffices. */
	readonly #refreshing = new Map<string, Promise<unknown>>();

	constructor(dataDir: string) {
		this.#file = new LockedFile(join(dataDir, "mcp-auth.json"));
	}

	/** The state store of server `name` at `url`, for pi-mcp's sign-in and auth provider. */
	forServer(name: string, url: string): McpOAuthServerStore {
		const key = keyOf(name, url);
		return {
			load: () => this.#file.withLockAsync(async (text) => ({ result: parseStates(text)[key] })),
			save: (state) =>
				this.#file.withLockAsync(async (text) => {
					const states = parseStates(text);
					states[key] = state;
					return { result: undefined, next: serialize(states) };
				}),
			withRefreshLock: (fn) => this.#withRefreshLock(key, fn),
		};
	}

	/** Whether tokens are stored for server `name` at `url`. */
	signedIn(name: string, url: string): Promise<boolean> {
		return this.#file.withLockAsync(async (text) => ({
			result: parseStates(text)[keyOf(name, url)]?.tokens !== undefined,
		}));
	}

	/** Forgets server `name` at `url`: its client, tokens and pending sign-in. */
	remove(name: string, url: string): Promise<void> {
		const key = keyOf(name, url);
		return this.#file.withLockAsync(async (text) => {
			const states = parseStates(text);
			if (!(key in states)) return { result: undefined };
			delete states[key];
			return { result: undefined, next: serialize(states) };
		});
	}

	/** Waits for pending writes. */
	close(): Promise<void> {
		return this.#file.close();
	}

	/** Runs `fn` after the server's previous refresh (not reentrant, as pi-mcp's lock). */
	async #withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.#refreshing.get(key) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(fn);
		this.#refreshing.set(key, run);
		try {
			return await run;
		} finally {
			if (this.#refreshing.get(key) === run) this.#refreshing.delete(key);
		}
	}
}

/** A server's key, as pi's: servers sharing a URL keep separate accounts. */
function keyOf(name: string, url: string): string {
	return `${mcpNamespace(name)}|${String(new URL(url))}`;
}

/** The file's states (a trust boundary: an edited file that is not an object counts as none). */
function parseStates(text: string | undefined): States {
	if (!text?.trim()) return {};
	const value: unknown = JSON.parse(stripBom(text));
	// The file is p2's own: its entries are states pi-mcp wrote.
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as States) : {};
}

function serialize(states: States): string {
	return `${JSON.stringify(states, null, 2)}\n`;
}
