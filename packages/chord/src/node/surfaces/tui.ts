// The terminal surface's server side (slice 11 §4, decisions "Slice 11, P3" and "P8"): the terminal kind's base bundle
// (one ES module the sandbox evaluates) built from the app's terminal entry at start, the kind's plugin scripts
// published as registered scripts and one combined file, `TuiScripts` showing the current set, all served to the
// launcher, which signs in with a token. Routes and objects are `Http` contributions of the surface's facet.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import { buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { type ServedFile, served } from "./served.ts";

/** What `tuiSurface` takes. */
export type TuiSurfaceOptions = {
	/** The terminal facet kind: `tui` by default. */
	readonly kind?: string;
	readonly plugins: Plugins;
	/** The app's terminal start code (it calls `startTerminalRuntime`): the base bundle's entry. */
	readonly entry: string;
};

/** What a launcher downloads at its start (`GET /_chord/tui/start`): the base bundle and the combined plugin file. */
export type TuiStart = { readonly base: string; readonly script: string; readonly combined: string };

/** The terminal surface: its facet (for the server's core facets), its rollout step, its base bundle's hash. */
export type TuiSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
};

/** Where the terminal surface's files live. */
export const TUI_PREFIX = "/_chord/tui/";

/** Builds the terminal's base bundle and takes the kind's current set, then returns the surface. */
export async function tuiSurface<P extends Principal>(
	server: Host<P>,
	options: TuiSurfaceOptions,
	context: Context,
): Promise<TuiSurface<P>> {
	const base = await buildBase(options.entry, "sandbox", TUI_PREFIX);
	const published = new PublishedScripts("tui", options.kind ?? "tui", TUI_PREFIX, base.hash, options.plugins, server);
	await published.start(context);
	const file = (path: string): ServedFile | undefined => base.files.get(path) ?? published.file(path);
	const serve = async (request: HttpRequest): Promise<HttpResponse> => served(file(request.path));
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", published).setup(host, self);
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => {
					const start: TuiStart = { base: base.hash, script: base.script, combined: published.set.combined };
					return { kind: "json", value: start, headers: { "Cache-Control": "no-store" } };
				},
				[`GET ${TUI_PREFIX}base`]: {
					public: true,
					handler: async () => ({ kind: "json", value: base.hash, headers: { "Cache-Control": "no-store" } }),
				},
				[`GET ${TUI_PREFIX}:file`]: serve,
				[`GET ${TUI_PREFIX}plugin/:file`]: serve,
			},
		});
	});
	return { facet, step: (name) => published.step(name), base: base.hash };
}
