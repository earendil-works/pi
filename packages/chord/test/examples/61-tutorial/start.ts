// The todo app's start: what the app decides itself, given to the kit's `startServer`: its name and data directory,
// its API, its facet kinds, its principals, its one worker kind (a list), its page and its terminal client, and its
// telemetry store (one SQLite file in the data directory, which the server writes for every process). The kit does the
// rest. The examples call `startTodo` with a copy of `plugins/` they may edit; a real app's start script calls it with
// the data directory from its command line and prints the owner link.

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v1 from "@todo/app/v1";
import * as v1server from "@todo/app/v1/server";
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { type PageAssets, pageScripts } from "../../../src/node/surfaces/index.ts";
import { principalAttributes, type TodoPrincipal } from "./src/principals.ts";
import type { TodoTelemetry } from "./src/telemetry.ts";

/** The app's API: its name, its versions (newest first), and this process's instances of its modules. */
export const API = {
	name: "@todo/app",
	versions: ["v1"],
	modules: { "@todo/app/v1": v1, "@todo/app/v1/server": v1server },
};

/** The app's facet kinds: a plugin has one file per kind it runs on (`server.ts`, `worker.ts`, `web.ts`, `tui.ts`). */
export const KINDS = {
	server: { platform: "node" },
	worker: { platform: "node" },
	web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
	tui: { platform: "node" },
} as const;

/** The page: the app's own HTML around the assets the kit made (the base bundle, the plugins' scripts and styles). */
function page(request: { readonly nonce: string }, assets: PageAssets): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Todo</title>${pageScripts(assets, request.nonce)}</head><body><div id="root"></div></body></html>`;
}

/**
 * Starts the todo app on a free loopback port, with its data in `dataDir`, its built-in plugins in `root`, recording to
 * `telemetry` (the store in `dataDir`).
 */
export function startTodo(
	dataDir: string,
	root: string,
	telemetry: TodoTelemetry,
	context: Context,
): Promise<App<TodoPrincipal>> {
	return startServer<TodoPrincipal>(
		{
			name: "todo",
			dataDir,
			root,
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			principal: {
				server: { kind: "server" },
				worker: (address) => ({ kind: "worker", list: address.key }),
				owner: { kind: "owner" },
			},
			// The store the server writes: its own spans and metrics, and what the workers and recording pages send.
			telemetry: telemetry.store,
			// Who a span was for: a short key and a user's name (each worker's `startWorker` gets the same hook).
			principalAttributes,
			workers: [
				{
					kind: v1.List,
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: () => ({}),
					// Who may reach a list's worker: everyone signed in, and the server itself.
					authorize: (principal) => principal.kind !== "worker",
				},
			],
			// The page, and the owner's trace viewer: the same page, which shows the viewer at `/traces`.
			web: { entry: fileURLToPath(new URL("./src/web/main.ts", import.meta.url)), page, paths: ["/", "/traces"] },
			tui: { entry: fileURLToPath(new URL("./src/tui/main.ts", import.meta.url)) },
			onError: (error) => console.error("todo:", error.kind, error.error),
		},
		context,
	);
}

/** A data directory and a copy of the app's plugins, in a new temporary directory. */
export async function todoDirectories(): Promise<{
	readonly base: string;
	readonly dataDir: string;
	readonly root: string;
}> {
	const base = await mkdtemp(join(tmpdir(), "todo-"));
	const root = join(base, "plugins");
	await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
	return { base, dataDir: join(base, "data"), root };
}
