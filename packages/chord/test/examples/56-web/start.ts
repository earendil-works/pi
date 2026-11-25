// The board app's start: its API, its kinds (the server, the web page, the terminal), its web entry and page template
// and its terminal entry, given to `startServer` (slice 13) with the surfaces of slice 11. Examples 56 to 58 call
// `startBoard` with a copy of `plugins/` they may edit.

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { type PageAssets, pageScripts } from "../../../src/node/surfaces/index.ts";
import type { BoardPrincipal } from "./app/principals.ts";
import * as v1 from "./app/v1.ts";

/** The board's page: the app's own template, the surface's assets in it. */
function page(request: { readonly nonce: string }, assets: PageAssets): string {
	return [
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Board</title>',
		pageScripts(assets, request.nonce),
		'</head><body><div id="root"></div></body></html>',
	].join("\n");
}

/** A data directory and a copy of the board's plugins, in a new temporary directory. */
export async function boardDirectories(): Promise<{
	readonly base: string;
	readonly dataDir: string;
	readonly root: string;
}> {
	const base = await mkdtemp(join(tmpdir(), "board-"));
	const root = join(base, "plugins");
	await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
	return { base, dataDir: join(base, "data"), root };
}

/** Starts the board on a free loopback port. */
export function startBoard(dataDir: string, root: string, context: Context): Promise<App<BoardPrincipal>> {
	return startServer<BoardPrincipal>(
		{
			name: "board",
			dataDir,
			root,
			listen: { host: "127.0.0.1", port: 0 },
			api: { name: "@board/app", versions: ["v1"], modules: { "@board/app/v1": v1 } },
			kinds: {
				server: { platform: "node" },
				web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
				tui: { platform: "node" },
			},
			principal: { server: { kind: "server" }, owner: { kind: "owner" } },
			web: { entry: fileURLToPath(new URL("./web/main.ts", import.meta.url)), page },
			tui: { entry: fileURLToPath(new URL("./tui/main.ts", import.meta.url)) },
			onError: (error) => console.error("board:", error.kind, error.error),
		},
		context,
	);
}
