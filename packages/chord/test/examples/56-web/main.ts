// The web surface (slice 11 §1-§3): a kit app (`start.ts`, the board) with a page. The server builds the page's base
// bundle from the app's web entry (`web/main.ts`: `startPage`, React) at start, serves the plugins' web facets as
// scripts that register themselves (one combined file at load), and the page through the app's template. A plugin
// edit applies in place: the page holds `WebScripts`, fetches the one changed script and reloads its host, keeping
// what is on screen. A browser is not needed here: a headless page in Node runs the same client code.
// Run from packages/chord (add `--serve` to keep the server running and open the owner link in a browser):
//   node --conditions=source --experimental-strip-types test/examples/56-web/main.ts
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import * as chord from "../../../src/index.ts";
import type { BoardPrincipal } from "./app/principals.ts";
import * as v1web from "./app/v1/web.ts";
import * as v1 from "./app/v1.ts";
import { headlessPage } from "./headless.ts";
import { boardDirectories, startBoard } from "./start.ts";

const { base, dataDir, root } = await boardDirectories();

// 1. Start the board: the base bundle is built now (named by its content), the plugins' web facets built and published.
const app = await startBoard(dataDir, root, context);
const link = new URL(app.ownerLink());
console.log("1. owner link:", `${link.origin}${link.pathname}#…`, "| base bundle:", app.web?.base);

// 2. The page, as a browser gets it (a command-line client's token here): the app's template with the assets.
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
const html = await (await fetch(new URL("/", link), { headers: { authorization: `Bearer ${token}` } })).text();
console.log("2. the page's scripts and stylesheets:");
for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) console.log(`   ${url}`);

// 3. A page loads the combined file and renders the panels its plugins contribute (here read from its host).
const core = chord.defineFacet<BoardPrincipal>((host) =>
	host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
);
const page = await headlessPage(link.origin, token, { "@board/app/v1": v1, "@board/app/v1/web": v1web }, [
	{ name: "@board/core", facet: core },
]);
const panels = await page.host.registry(v1web.Panels, context);
console.log("3. panels:", panels.value.map(({ title, text }) => `${title}: ${text}`).join(" | "));

// 4. Edit the clock plugin and apply the change: the page fetches the clock's new script only and reloads in place.
await writeFile(
	join(root, "clock", "web.ts"),
	(await readFile(join(root, "clock", "web.ts"), "utf8")).replace("12:00", "12:01"),
);
while (!app.plugins.state.value.dirty.includes("@board/clock")) await new Promise((resolve) => setTimeout(resolve, 10));
const rollout = await app.applyChanges(context);
console.log("4. rolled out to:", rollout.steps.map(({ name }) => name).join(", "));
while (!panels.value.some(({ text }) => text === "12:01")) await new Promise((resolve) => setTimeout(resolve, 10));
console.log("   panels:", panels.value.map(({ title, text }) => `${title}: ${text}`).join(" | "));

if (process.argv.includes("--serve")) {
	console.log(`Open ${app.ownerLink()} (Ctrl-C to stop)`);
} else {
	await page.stop(context);
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
