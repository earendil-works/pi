// The chat's start: one server keeping the channel list and the surfaces, one worker per channel, a web page at `/chat`
// (the sign-in page at `/` comes from the chat plugin) and a terminal client. No harness: the app is its API, two
// plugins and its two client entries.

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { type PageAssets, pageScripts } from "../../../src/node/surfaces/index.ts";
import type { ChatPrincipal } from "./app/principals.ts";
import * as v1server from "./app/v1/server.ts";
import * as v1worker from "./app/v1/worker.ts";
import * as v1 from "./app/v1.ts";

/** The chat's API, as the server and the channel workers have it. */
export const API = {
	name: "@chat/app",
	versions: ["v1"],
	modules: { "@chat/app/v1": v1, "@chat/app/v1/server": v1server, "@chat/app/v1/worker": v1worker },
};

/** The chat's facet kinds. */
export const KINDS = {
	server: { platform: "node" },
	worker: { platform: "node" },
	web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
	tui: { platform: "node" },
} as const;

/** The chat page: the app's template around the surface's assets. */
function page(request: { readonly nonce: string }, assets: PageAssets): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat</title>${pageScripts(assets, request.nonce)}</head><body><div id="root"></div></body></html>`;
}

/** A data directory and a copy of the chat's plugins, in a new temporary directory. */
export async function chatDirectories(): Promise<{
	readonly base: string;
	readonly dataDir: string;
	readonly root: string;
}> {
	const base = await mkdtemp(join(tmpdir(), "chat-"));
	const root = join(base, "plugins");
	await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
	return { base, dataDir: join(base, "data"), root };
}

/** Starts the chat on a free loopback port. */
export function startChat(dataDir: string, root: string, context: Context): Promise<App<ChatPrincipal>> {
	return startServer<ChatPrincipal>(
		{
			name: "chat",
			dataDir,
			root,
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			principal: {
				server: { kind: "server" },
				worker: (address) => ({ kind: "worker", channel: address.key }),
				// The owner is a user like those who pick a name (theirs get fresh random ids, never "owner").
				owner: { kind: "user", id: "owner", name: "owner" },
			},
			workers: [
				{
					kind: v1.Channel,
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: () => ({}),
					// Every user, the owner among them, may join a channel.
					authorize: (principal) => principal.kind === "user",
				},
			],
			web: { entry: fileURLToPath(new URL("./web/main.ts", import.meta.url)), page, paths: ["/chat"] },
			tui: { entry: fileURLToPath(new URL("./tui/main.ts", import.meta.url)) },
			onError: (error) => console.error("chat:", error.kind, error.error),
		},
		context,
	);
}
