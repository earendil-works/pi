// Tests of the terminal surface's server side (slice 11 §4), through the app kit: the start a launcher downloads (signed
// in only), the base hash (public), the base bundle (an ES module answering builtins for bundled CommonJS) and the
// plugin scripts registering themselves. A terminal plugin has no assets: a Node build refuses them (Opus L5).

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { TuiScripts } from "../../../src/index.ts";
import type { TuiStart } from "../../../src/node/surfaces/index.ts";
import { send } from "../http/support.ts";
import { writePlugin } from "../plugins/support.ts";
import { tuiApp } from "../tui/support.ts";

describe("the terminal surface", () => {
	it("serves a signed-in launcher its start, the base bundle and the scripts; the base hash to anyone", async () => {
		const { app, port, root } = await tuiApp();
		try {
			const headers = { authorization: `Bearer ${(await readFile(app.ownerTokenFile, "utf8")).trim()}` };
			expect((await send(port, "GET", "/_chord/tui/start")).status).toBe(401);
			const start = JSON.parse(
				(await send(port, "GET", "/_chord/tui/start", { headers })).body.toString(),
			) as TuiStart;
			expect(start).toEqual({
				base: app.tui!.base,
				script: `/_chord/tui/base.${app.tui!.base}.js`,
				combined: expect.stringMatching(/^\/_chord\/tui\/plugins\.[0-9a-f]{16}\.js$/),
			});
			expect(JSON.parse((await send(port, "GET", "/_chord/tui/base")).body.toString())).toBe(app.tui!.base);
			const base = (await send(port, "GET", start.script, { headers })).body.toString();
			// A CommonJS script (the sandbox gives it its own `require`), no ES module.
			expect(base).toContain("require(");
			expect(base).not.toMatch(/^\s*(?:import|export)\b/m);
			const scripts = await app.host.get(TuiScripts, {}, context);
			const [entry] = scripts.set.value.plugins;
			expect(entry!.url).toBe(`/_chord/tui/plugin/@test~lines.${entry!.digest}.js`);
			const script = (await send(port, "GET", entry!.url, { headers })).body.toString();
			expect(script.startsWith(`chordFacet("@test/lines","${entry!.digest}",`)).toBe(true);
			expect((await send(port, "GET", start.combined, { headers })).body.toString()).toBe(
				script.replace(/\n\/\/# sourceMappingURL=data:[^\n]*/, ""),
			);
			scripts.release();
			// Terminal facets are Node builds: an asset import fails the build, so the surface serves none.
			await writePlugin(root, "pictured", "@test/pictured", {
				"tui.ts": 'import icon from "./icon.svg?url";\nexport default { setup: () => icon };',
				"icon.svg": "<svg/>",
			});
			const built = await app.plugins.component.build(["@test/pictured"], context);
			expect(built.facets.find(({ plugin }) => plugin === "@test/pictured")).toMatchObject({
				kind: "failed",
				errors: [expect.stringContaining("assets by URL are for browser builds")],
			});
		} finally {
			await app.close(context);
		}
	});
});
