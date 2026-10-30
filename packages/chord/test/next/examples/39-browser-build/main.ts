// A browser build (slice 7c §2): a facet of a browser kind (`browserKinds: ["web"]`) is built for the browser. Its
// stylesheets become one CSS file (`css`), an asset imported by URL (`./logo.svg?url`) a content-hashed file whose
// import evaluates to its URL under the app's `publicPath`. The build is plain data: script, stylesheet and assets,
// what the app serves to its pages (slice 11 ships it); a page evaluates the script with its host packages, as Node
// does here. A Node builtin is refused in a browser build. The example only reads `plugins/`: no copy.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/39-browser-build/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { local, str } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { createPlugins, evaluateFacet } from "../../../../src/next-node/plugins/index.ts";

const context = BACKGROUND_CONTEXT;
const root = fileURLToPath(new URL("./plugins/", import.meta.url));

// 1. The component: `web` is a browser kind; its assets are served under `/plugin-assets/`.
const hostPackages = { "@earendil-works/chord/next": chordNext };
const plugins = createPlugins(
	{
		roots: [root],
		kinds: ["web"],
		browserKinds: ["web"],
		publicPath: "/plugin-assets/",
		hostPackages,
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. The first build: every discovered plugin.
const built = await plugins.build([], context);
const gallery = built.facets.find(({ plugin }) => plugin === "@example/gallery")!;
const bad = built.facets.find(({ plugin }) => plugin === "@example/bad-web")!;
if (gallery.kind !== "script" || bad.kind !== "failed") throw new Error("unexpected build results");
console.log("1. @example/gallery/web: script of", gallery.source.length, "bytes, digest", gallery.digest.slice(0, 12));
console.log("   stylesheet:", gallery.css?.name, JSON.stringify(gallery.css?.text.split("\n")[0]));
for (const asset of gallery.assets) console.log("   asset:", asset.name, `(${asset.bytes.length} bytes)`);
console.log("   the asset's URL in the script:", /\/plugin-assets\/[^"]+/.exec(gallery.source)?.[0]);
console.log("   read:", gallery.inputs.map(({ file }) => file.slice(root.length)).join(", "));
console.log("2. @example/bad-web/web:", bad.errors.join("; "));

// 3. Plain data: a structured clone (what a message to a page or a worker carries) is the same build.
const shipped = structuredClone(built);
const copy = shipped.facets.find(({ plugin }) => plugin === "@example/gallery")!;
console.log(
	"3. cloned:",
	copy.kind === "script" && copy.digest === gallery.digest,
	"| its plugins:",
	Object.keys(shipped.plugins).join(", "),
);

// 4. Where it runs (a page; Node stands in here), the script is evaluated with the host packages and loaded.
const Gallery = local("example.gallery", { version: 1, params: {}, members: { logo: str() } });
if (copy.kind === "script") {
	const facet = evaluateFacet(copy, { hostPackages, plugin: shipped.plugins["@example/gallery"]! });
	const page = createHost({ onError: () => {} });
	await page.load([{ name: "@example/gallery", facet }], context);
	console.log("4. the gallery's logo on the page:", (await page.get(Gallery, {}, context)).logo.value);
	await page.close(context);
}

plugins.close();
