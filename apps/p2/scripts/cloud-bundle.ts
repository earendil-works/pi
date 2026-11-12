// Builds p2's web UI for Radius Cloud Brain into `<out>/<sha>/`: the plugins' web facets, their stylesheet and a
// manifest.json naming both. Radius serves the `pi-ui` bucket under `/pi/ui/` and puts the Chord URL in the page's
// `#root` `data-pi-bootstrap`; the built script assumes p2 serves it, so its Chord socket and its version poll are
// patched. A missing patch target, or anything else still loaded from p2's `/__p2_web/`, fails the build:
// `src/hosts/web/main.tsx` or `WEB_BUNDLE_PATH` changed, and this script must follow.
//
//   node --import ./src/source.ts scripts/cloud-bundle.ts <full commit sha> <out dir>

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWebBundle } from "../src/hosts/bundles.ts";

/** The plugins Cloud Brain serves. `web-shell` registers the "app" slot; without it the page stays on "Loading…". */
const PLUGINS = ["web-shell", "artifacts", "chat", "drafts", "models", "sessions", "status", "subagents", "workspace"];

const [sha, out] = process.argv.slice(2);
if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !out) throw new Error("usage: cloud-bundle.ts <full commit sha> <out dir>");

const base = `/pi/ui/${sha}`;
const dir = join(out, sha);
const bundle = await buildWebBundle(PLUGINS);
await mkdir(dir, { recursive: true });

// Source maps embed the sources and the bundle is served publicly: they are left out, and so are the comments naming
// them (the last line of the script and of the stylesheet).
for (const [file, { body }] of bundle.files) {
	if (file.endsWith(".map")) continue;
	let text = new TextDecoder().decode(body);
	if (file === bundle.script) text = patchScript(text.replace(/\n\/\/# sourceMappingURL=\S+\n?$/, "\n"));
	else if (file === bundle.style) text = text.replace(/\n\/\*# sourceMappingURL=\S+ \*\/\n?$/, "\n");
	await writeFile(join(dir, file), text);
}
const manifest = {
	version: `pi-${sha}`,
	script: bundle.script,
	stylesheets: bundle.style ? [bundle.style] : [],
	commit: sha,
};
await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${dir}`);

function patchScript(script: string): string {
	// The socket names p2's own bundle version (`?web=`, so p2 refuses a stale page); a Cloud Brain page is no p2-served
	// page and names none. The version's variable is minified, hence a pattern.
	script = patch(
		script,
		/new WebSocket\(`\$\{location\.protocol==="https:"\?"wss":"ws"\}:\/\/\$\{location\.host\}\/chord\?web=\$\{encodeURIComponent\([\w$]+\)\}`\)/g,
		'new WebSocket(JSON.parse(document.getElementById("root").dataset.piBootstrap).chordUrl)',
	);
	script = patch(
		script,
		'fetch("/__p2_web",{cache:"no-store",credentials:"same-origin"})',
		`fetch("${base}/manifest.json",{cache:"no-store"})`,
	);
	if (script.includes("__p2_web")) throw new Error("the built script still names /__p2_web");
	return script;
}

function patch(source: string, from: string | RegExp, to: string): string {
	if (typeof from === "string" ? !source.includes(from) : !from.test(source))
		throw new Error(`patch target not found: ${from}`);
	if (typeof from !== "string") from.lastIndex = 0;
	return typeof from === "string" ? source.replaceAll(from, to) : source.replace(from, to);
}
