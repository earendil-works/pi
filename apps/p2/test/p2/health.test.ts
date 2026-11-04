// /health without signing in (Pi Mobile's readiness check for launchers) and the installable app's manifest.
// Bundle polling and a real plugin reload are covered in dev.test.ts; an unchanged restart keeping the same page is
// covered in ui-reconnect.test.ts. Disposable data, fake provider.
import assert from "node:assert/strict";
import { it } from "node:test";
import { http, startFixture } from "./helpers.ts";

it("serves /health without signing in (known hosts only), and the app manifest", async (t) => {
	const fixture = await startFixture({ web: true, allowedHosts: ["share.test"] });
	t.after(() => fixture.close());
	const port = fixture.server.port;
	for (const headers of [{}, { Host: "share.test", Origin: "https://share.test" }] as Record<string, string>[]) {
		const health = await http(port, "/health", { headers });
		assert.equal(health.status, 200);
		assert.deepEqual(JSON.parse(health.body), { ok: true, name: "p2" });
	}
	assert.equal((await http(port, "/health", { headers: { Host: "evil.test" } })).status, 403);
	const manifest = await http(port, "/manifest.webmanifest");
	assert.equal(manifest.status, 200);
	assert.equal((JSON.parse(manifest.body) as { name: string }).name, "Pi");
});
