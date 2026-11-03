// Tests of the page's language (decision "Messages and languages in the app kit" (3)) in a real browser (Chromium;
// skipped without one): the root element's `lang` and `dir` follow the device's languages matched against the catalogs,
// then the user's pick, right to left for a right-to-left locale a plugin contributes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { LocaleChoice } from "../../../src/index.ts";
import { Browser, CHROMIUM } from "./browser.ts";
import { freePort, signIn, versionedEntry, webApp } from "./support.ts";

/** A web plugin contributing an Arabic catalog of the page's messages. */
const ARABIC = {
	"web.ts": [
		'import { defineFacet, Translations } from "@test/app/v1";',
		'export default defineFacet((_host, self) => self.contribute(Translations, [{ namespace: "test.page", locale: "ar", messages: { hello: "مرحبا" } }]));',
	].join("\n"),
};

describe.skipIf(CHROMIUM === undefined)("the page's language", () => {
	let browser: Browser;

	beforeAll(async () => {
		browser = await Browser.start();
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it("writes lang and dir on the root element, from the device, then the user's pick", async () => {
		const { app } = await webApp(await versionedEntry("1"), await freePort(), { plugins: { arabic: ARABIC } });
		try {
			await signIn(browser, app.ownerLink());
			await browser.wait('document.getElementById("greeting") !== null');
			// The browser's own languages (English), matched against the catalogs' locales.
			expect(await browser.evaluate<string>("document.documentElement.lang")).toBe("en");
			await app.host.root(async (ctx) => (await ctx.get(LocaleChoice, {})).choose("ar", ctx), context, {
				principal: { kind: "owner" },
			});
			await browser.wait('document.documentElement.dir === "rtl"');
			expect(await browser.evaluate<string>("document.documentElement.lang")).toBe("ar");
			// The key Arabic lacks falls back to the first catalog, key by key.
			expect(await browser.evaluate<string>('document.getElementById("greeting").textContent')).toBe(
				"مرحبا, 2 clicks",
			);
		} finally {
			await app.close(context);
		}
	}, 120_000);
});
