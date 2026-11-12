// Builds p2's web UI for Radius Cloud Brain into `<out>/<sha>/`: one script, one stylesheet, their assets, and a
// manifest.json naming them. Radius serves the `pi-ui` bucket under `/pi/ui/` and puts the Chord URL in the page's
// `#root` `data-pi-bootstrap`. The page is static (`startPage({ follow: false })`, src/hosts/web/main.tsx): built here
// with Chord's builders as a p2 page is, its script being Chord's page bootstrap, the plugins' web scripts (registered
// as the web surface registers them) and the base bundle, in that order, and its stylesheet the base's and the
// plugins' in order. Assets are named by their content under `/pi/ui/<sha>/assets/`.
//
//   node --import ./src/source.ts scripts/cloud-bundle.ts <full commit sha> <out dir>

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registeredSource } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildBase, pageBootstrap } from "@earendil-works/chord/surfaces";
import { createP2Plugins } from "../src/hosts/plugins.ts";
import { WEB_ENTRY, WEB_RESOLUTION } from "../src/hosts/web/base.ts";

/** The plugins Cloud Brain serves. `web-shell` registers the "app" slot; without it the page stays on "Loading…". */
const PLUGINS = ["web-shell", "artifacts", "chat", "drafts", "models", "sessions", "status", "subagents", "workspace"];

/** A script's inline source map comment (the bundle is served publicly: no sources). */
const SOURCE_MAP = /\n\/\/# sourceMappingURL=[^\n]*/g;

const [sha, out] = process.argv.slice(2);
if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !out) throw new Error("usage: cloud-bundle.ts <full commit sha> <out dir>");

const prefix = `/pi/ui/${sha}/`;
const dir = join(out, sha);
await mkdir(join(dir, "assets"), { recursive: true });

const base = await buildBase(WEB_ENTRY, "browser", prefix, WEB_RESOLUTION);
const p2Plugins = createP2Plugins(
	PLUGINS,
	(error) => console.error("cloud-bundle:", error),
	BACKGROUND_CONTEXT,
	undefined,
	`${prefix}assets/`,
);
const scripts: string[] = [];
const styles: string[] = [];
try {
	for (const { plugin, built } of await p2Plugins.plugins.scripts("web", BACKGROUND_CONTEXT)) {
		if (built.kind !== "script") throw new Error(`plugin ${plugin.name}: ${built.errors.join("\n")}`);
		scripts.push(registeredSource(plugin.name, built.digest, built.source).replace(SOURCE_MAP, ""));
		if (built.css !== undefined) styles.push(built.css.text);
		for (const asset of built.assets) await writeFile(join(dir, "assets", asset.name), asset.bytes);
	}
} finally {
	p2Plugins.close();
}

let script = "";
for (const [path, file] of base.files) {
	const text = () => new TextDecoder().decode(file.bytes).replace(SOURCE_MAP, "");
	if (path === base.script) script = text();
	else if (path === base.style) styles.unshift(text());
	else await writeFile(join(dir, path.slice(prefix.length)), file.bytes);
}
const page = [pageBootstrap(base.hash, { base: base.hash, combined: "", plugins: [] }), ...scripts, script].join("\n");
const style = styles.join("\n");
const named = (text: string, extension: string) =>
	`app-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.${extension}`;
const scriptFile = named(page, "js");
const styleFile = named(style, "css");
await writeFile(join(dir, scriptFile), page);
await writeFile(join(dir, styleFile), style);
const manifest = { version: `pi-${sha}`, script: scriptFile, stylesheets: [styleFile], commit: sha };
await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${dir}`);
