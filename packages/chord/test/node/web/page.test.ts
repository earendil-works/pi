// Tests of a page (slice 11 §2, §4b) in a real browser (Chromium; skipped without one): `startPage` loads the plugins
// of the combined file, keeps its link, applies a plugin edit in place keeping a component's state, writes the active
// theme as CSS variables following the colour scheme, and reloads when the server's base bundle changed.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Browser, CHROMIUM } from "./browser.ts";
import { freePort, panelPlugin, signIn, versionedEntry, webApp } from "./support.ts";

describe.skipIf(CHROMIUM === undefined)("a page", () => {
	let browser: Browser;

	beforeAll(async () => {
		browser = await Browser.start();
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it("loads the plugins, applies an edit in place keeping the page's state, and follows the theme", async () => {
		const { app, root } = await webApp(await versionedEntry("1"), await freePort(), {
			plugins: { notes: panelPlugin("Notes", "#123456") },
		});
		try {
			await browser.call("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			});
			await signIn(browser, app.ownerLink());
			await browser.wait('document.querySelector(".panel")?.textContent === "Notes"');
			await browser.wait('globalThis.connection === "connected"');
			await browser.wait(
				'getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#123456"',
			);
			// Component state, then a plugin edit rolled out: the page applies it in place.
			await browser.evaluate('document.getElementById("draft").focus()');
			await browser.type("half-typed");
			await writeFile(join(root, "notes", "web.ts"), panelPlugin("Notes v2", "#654321")["web.ts"]!);
			while (!app.plugins.state.value.dirty.includes("@test/notes"))
				await new Promise((resolve) => setTimeout(resolve, 10));
			const result = await app.applyChanges(context);
			expect(result.steps.map(({ name }) => name)).toEqual(["server", "web"]);
			await browser.wait('document.querySelector(".panel")?.textContent === "Notes v2"');
			await browser.wait(
				'getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#654321"',
			);
			expect(await browser.evaluate<string>('document.getElementById("draft").value')).toBe("half-typed");
			expect(await browser.evaluate<number>("globalThis.loads")).toBe(1);
			// The colour scheme changes: the light theme (here the fallback), without a reload.
			await browser.call("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: "light" }],
			});
			await browser.wait(
				'getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#0b62d6"',
			);
			expect(await browser.evaluate<string>("getComputedStyle(document.documentElement).colorScheme")).toBe("light");
		} finally {
			await app.close(context);
		}
	}, 120_000);

	it("reloads when the server comes back with another base bundle", async () => {
		const port = await freePort();
		const entry = await versionedEntry("1");
		const first = await webApp(entry, port, { plugins: { notes: panelPlugin("Notes", "#123456") } });
		await signIn(browser, first.app.ownerLink());
		await browser.wait('globalThis.version === "1" && globalThis.connection === "connected"');
		await first.app.close(context);
		await browser.wait('globalThis.connection === "waiting" || globalThis.connection === "connecting"');
		await versionedEntry("2", join(entry, ".."));
		const second = await webApp(entry, port, { dataDir: first.dataDir, root: first.root });
		try {
			expect(second.app.web!.base).not.toBe(first.app.web!.base);
			await browser.wait('globalThis.version === "2" && globalThis.connection === "connected"', 60_000);
			// The panel follows the connection by a frame or two (Opus L6).
			await browser.wait('document.querySelector(".panel")?.textContent === "Notes"');
		} finally {
			await second.app.close(context);
		}
	}, 120_000);
});
