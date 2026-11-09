// p2's plugins are laid out for Chord's plugin builder (`@earendil-works/chord/plugins`): every plugin directory is a
// package, and every facet builds on its own against p2's plugin API (`@p2/app/v1`), with no import of base code by
// path, of Chord directly, of another plugin's non-contract files or of another kind's files.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { buildFacet, discoverPlugins } from "@earendil-works/chord/plugins";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { APP } from "./helpers.ts";

const KINDS = ["server", "worker", "tui", "web"] as const;

/** The packages a facet shares with its host as instances (never bundled), besides the API. */
const SHARED = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/api/anthropic-messages.lazy",
	"@earendil-works/pi-ai/api/google-generative-ai.lazy",
	"@earendil-works/pi-ai/api/openai-completions.lazy",
	"@earendil-works/pi-ai/api/openai-responses.lazy",
	"@earendil-works/pi-ai/models",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-ai/providers/faux",
	"@earendil-works/pi-ai/providers/radius",
	"@earendil-works/pi-ai/providers/radius-config",
	"@earendil-works/pi-codemode",
	"@earendil-works/pi-durable",
	"@earendil-works/pi-durable/codemode",
	"@earendil-works/pi-durable/env",
	"@earendil-works/pi-durable/env/node",
	"@earendil-works/pi-durable/tool-search",
	"@earendil-works/pi-durable/tools",
	"@earendil-works/pi-env",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-mcp/oauth",
	"@earendil-works/pi-schema",
	"@earendil-works/pi-schema/formats",
	"@earendil-works/pi-tui",
	"ws",
	"yaml",
];

/** The API modules each kind may import. */
const API: Record<(typeof KINDS)[number], readonly string[]> = {
	server: ["@p2/app/v1", "@p2/app/v1/node", "@p2/app/v1/server", "discord.js"],
	worker: ["@p2/app/v1", "@p2/app/v1/node", "@p2/app/v1/worker"],
	tui: ["@p2/app/v1", "@p2/app/v1/tui"],
	web: ["@p2/app/v1", "@p2/app/v1/web", "react", "react/jsx-runtime"],
};

test("every plugin directory is a package named after it", async () => {
	const { plugins, problems } = await discoverPlugins(
		[{ path: join(APP, "plugins"), required: true }],
		{ kinds: [...KINDS] },
		BACKGROUND_CONTEXT,
	);
	assert.deepEqual(problems, []);
	for (const plugin of plugins) assert.equal(plugin.name, relative(join(APP, "plugins"), plugin.dir));
});

test("every server, worker, TUI and web facet builds against the plugin API alone", async () => {
	const { plugins } = await discoverPlugins(
		[{ path: join(APP, "plugins"), required: true }],
		{ kinds: [...KINDS] },
		BACKGROUND_CONTEXT,
	);
	const failures: string[] = [];
	for (const plugin of plugins) {
		for (const kind of KINDS) {
			if (plugin.facets[kind] === undefined) continue;
			const built = await buildFacet(
				plugin,
				kind,
				{
					hostPackages: [...API[kind], ...SHARED],
					platform: kind === "web" ? "browser" : "node",
					api: { name: "@p2/app", versions: ["v1"] },
					kinds: KINDS,
					plugins,
				},
				BACKGROUND_CONTEXT,
			);
			if (built.kind === "failed") failures.push(...built.errors.map((error) => `${plugin.name}/${kind}: ${error}`));
		}
	}
	assert.deepEqual(failures, []);
});

test("p2's tsconfig maps every workspace package the repository's maps, and the plugin API", () => {
	const paths = (directory: string) =>
		(
			JSON.parse(readFileSync(join(directory, "tsconfig.json"), "utf8")) as {
				compilerOptions: { paths: Record<string, string[]> };
			}
		).compilerOptions.paths;
	const repository = resolve(APP, "../..");
	const absolute = (directory: string, entries: Record<string, string[]>) =>
		Object.fromEntries(
			Object.entries(entries).map(([pattern, targets]) => [
				pattern,
				targets.map((target) => resolve(directory, target)),
			]),
		);
	const own = absolute(APP, paths(APP));
	for (const [pattern, targets] of Object.entries(absolute(repository, paths(repository)))) {
		if (pattern.startsWith("@earendil-works/") || pattern === "typebox")
			assert.deepEqual(own[pattern], targets, pattern);
	}
	assert.deepEqual(own["@p2/app/v1"], [join(APP, "src/api/v1/index.ts")]);
});
