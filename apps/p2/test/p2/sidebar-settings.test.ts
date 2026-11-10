// Sidebar settings (plugins/sessions/sidebar-settings.ts): the owner's rollup order, windows and collapsed rollups and
// groups, kept across a restart of the server, and the owner's only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { SidebarSettings } from "../../plugins/sessions/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { expectChord, holdIn, startFixture, until } from "./helpers.ts";

test("sidebar settings are the owner's, start empty, and are kept across a restart", async (t) => {
	const fixture = await startFixture();
	let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
	t.after(async () => {
		await restarted?.close();
		await fixture.close();
	});
	const settings = await holdIn(fixture.browser(), SidebarSettings, {}, "owner");
	assert.deepEqual(await until(settings.order, (order) => order !== undefined), []);
	assert.deepEqual(settings.windows.value, {});
	assert.deepEqual(settings.collapsed.value, {});
	// A repeated key in the order counts once.
	await settings.setOrder({ order: ["folders", "recent", "folders"] }, BACKGROUND_CONTEXT);
	await settings.setWindow({ key: "recent", window: "1w" }, BACKGROUND_CONTEXT);
	await settings.setCollapsed({ key: "projects", collapsed: true }, BACKGROUND_CONTEXT);
	assert.deepEqual(settings.order.value, ["folders", "recent"]);

	const guest = fixture
		.as({ kind: "guest", id: "guest", name: "Guest", home: "unknown", sessions: { unknown: "full" }, revision: 1 })
		.hold(SidebarSettings, {}, BACKGROUND_CONTEXT);
	await expectChord(whenLive(guest), "forbidden");
	guest.release();

	await fixture.server.close();
	restarted = await startServer({ dataDir: fixture.dataDir, port: fixture.server.port, fake: true, web: false });
	const after = await holdIn(fixture.browser(), SidebarSettings, {}, "owner");
	assert.deepEqual(await until(after.order, (order) => order?.length === 2), ["folders", "recent"]);
	assert.deepEqual(after.windows.value, { recent: "1w" });
	assert.deepEqual(after.collapsed.value, { projects: true });
});
