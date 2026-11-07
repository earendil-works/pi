// A page without a browser, for examples 56 and 58: what `startPage` does, run in Node. It loads the page's combined
// file and runs its registered scripts (`vm` here; `<script src>` in a browser), connects to `/chord` with the session
// token, and keeps its plugins current with `startClient` (the same code `startPage` runs). No DOM: what the page would
// render is read from its host.

import { Script } from "node:vm";
import { WebSocket } from "ws";
import {
	type Client,
	type ClientModules,
	type FacetFunction,
	type PluginFacet,
	REGISTER,
	type RegisteredScript,
	startClient,
	WebScripts,
	type WebSocketLike,
	webSocketLink,
} from "../../../src/index.ts";
import type { BoardPrincipal } from "./app/principals.ts";

/** Runs registered scripts' `text` and returns what registered. */
function run(text: string): RegisteredScript[] {
	const registered: RegisteredScript[] = [];
	(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, f: FacetFunction) =>
		registered.push({ plugin, digest, run: f });
	new Script(text).runInThisContext();
	return registered;
}

/** Opens a headless page of the app at `url` signed in with `token`. */
export async function headlessPage(
	url: string,
	token: string,
	modules: ClientModules,
	core: readonly PluginFacet<BoardPrincipal>[],
): Promise<Client<BoardPrincipal>> {
	const headers = { authorization: `Bearer ${token}` };
	const get = async (path: string): Promise<string> => (await fetch(new URL(path, url), { headers })).text();
	const html = await get("/");
	const base = /chordPage=\{"base":"([0-9a-f]+)"/.exec(html)![1]!;
	const combined = /src="(\/_chord\/web\/plugins\.[0-9a-f]+\.js)"/.exec(html)![1]!;
	return startClient<BoardPrincipal>({
		scripts: WebScripts,
		base,
		initial: run(await get(combined)),
		modules,
		core,
		open: (events) => {
			const socket = new WebSocket(new URL("/chord", url.replace(/^http/, "ws")), { headers });
			socket.on("open", () => events.opened());
			socket.on("message", () => events.received());
			return webSocketLink(socket as unknown as WebSocketLike);
		},
		fetchScript: async (entry) => run(await get(entry.url))[0]!,
		serverBase: async () => JSON.parse(await get("/_chord/web/base")) as string,
		outdated: () => console.log("   (the page would reload: the server has a new base bundle)"),
		environment: {
			now: () => Date.now(),
			after: (ms, callback) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
			online: () => true,
			onWake: () => () => {},
		},
		onError: (error) => console.log("   page:", error.kind),
	});
}
