// Test support for the web surface in a real browser (slice 11 §6): a kit app with the web surface whose entry imports
// the fixture's web entry and a version (changing it changes the base bundle), its page template, a web plugin, and the
// browser signed in as the owner through the owner link.

import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppOptions } from "../../../src/node/app/index.ts";
import { pageScripts } from "../../../src/node/surfaces/index.ts";
import { type TestPrincipal, tempDir, testApp } from "../app/support.ts";
import type { Browser } from "./browser.ts";

/** The fixture's web entry. */
const MAIN = fileURLToPath(new URL("../fixtures/web/main.ts", import.meta.url));

/** A web plugin contributing the panel `title` and the themes `accent` colours. */
export function panelPlugin(title: string, accent: string): Record<string, string> {
	const colors = `{ accent: ${JSON.stringify(accent)}, bg: "#000000", fg: "#ffffff", muted: "#888888", error: "#ff0000", warning: "#ffff00", success: "#00ff00" }`;
	return {
		"web.ts": [
			'import { defineFacet, Themes } from "@test/app/v1";',
			'import { Panels } from "@test/app/v1/web";',
			"export default defineFacet((_host, self) => {",
			`\tself.contribute(Panels, ${JSON.stringify(title)});`,
			`\tself.contribute(Themes, { id: "test", name: "Test", mode: "dark", colors: ${colors} });`,
			"});",
		].join("\n"),
	};
}

/** A web entry in a new directory importing the fixture's with `version`: its path. */
export async function versionedEntry(version: string, dir?: string): Promise<string> {
	const at = dir ?? (await tempDir());
	const text = `import { start } from ${JSON.stringify(MAIN)};\n(globalThis as Record<string, unknown>).version = ${JSON.stringify(version)};\nstart();\n`;
	await writeFile(join(at, "main.ts"), text);
	return join(at, "main.ts");
}

/** The tests' page template. */
export function page(request: { readonly nonce: string }, assets: Parameters<typeof pageScripts>[0]): string {
	return `<!doctype html><html><head><meta charset="utf-8">${pageScripts(assets, request.nonce)}</head><body><div id="root"></div></body></html>`;
}

/** A free port on loopback. */
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** A kit app with the web surface at `port` (fixed: a restarted server keeps it) and `plugins`. */
export function webApp(
	entry: string,
	port: number,
	more: {
		readonly dataDir?: string;
		readonly root?: string;
		readonly plugins?: Record<string, Record<string, string>>;
		readonly withWorkers?: boolean;
		readonly telemetry?: AppOptions<TestPrincipal>["telemetry"];
	} = {},
) {
	return testApp({
		kinds: {
			server: { platform: "node" },
			worker: { platform: "node" },
			web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
		},
		listen: { host: "127.0.0.1", port },
		web: { entry, page },
		...more,
	});
}

/** Signs `browser` in with `link` (the owner link) and waits for the page's app. */
export async function signIn(browser: Browser, link: string): Promise<void> {
	await browser.open(link);
	await browser.wait('document.getElementById("panels")');
}
