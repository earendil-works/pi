// A Radius user's credential kept current (src/runtime/radius-client.ts), as the brain, the TUI launcher and p2's owner
// access use it: refreshed when about to expire, once for concurrent callers, saved or kept in memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { radiusCredentials } from "../../src/runtime/radius-client.ts";
import { fakeRadius } from "./radius-fixture.ts";

test("an expiring credential is refreshed once for concurrent callers, then saved or kept in memory", async (t) => {
	const radius = await fakeRadius();
	t.after(() => radius.close());
	const expiring: OAuthCredential = { type: "oauth", access: "old", refresh: "r1", expires: Date.now() + 1000 };
	let stored = { gateway: radius.gateway, credential: expiring };
	const saved: string[] = [];
	const saving = radiusCredentials(async () => stored, {
		save: async (current, credential) => {
			saved.push(credential.access);
			stored = { ...current, credential };
			return stored;
		},
	});
	const answers = await Promise.all([saving(), saving(), saving()]);
	assert.deepEqual(
		answers.map((answer) => answer?.credential.access),
		["refreshed-1", "refreshed-1", "refreshed-1"],
	);
	assert.deepEqual(radius.refreshes, ["r1"]);
	assert.deepEqual(saved, ["refreshed-1"]);
	assert.equal((await saving())?.credential.access, "refreshed-1", "the saved credential is current");
	// Without `save`, the refreshed credential lives in memory while the file still has the refresh token it came from.
	const file = { gateway: radius.gateway, credential: { ...expiring, refresh: "r2" } };
	let read = file;
	const memory = radiusCredentials(async () => read);
	assert.equal((await memory())?.credential.access, "refreshed-2");
	assert.equal((await memory())?.credential.access, "refreshed-2");
	assert.deepEqual(radius.refreshes, ["r1", "r2"]);
	// A new sign-in (another refresh token) is refreshed on its own; a current one is used as it is; signed out is undefined.
	read = { ...file, credential: { ...file.credential, refresh: "r3" } };
	assert.equal((await memory())?.credential.access, "refreshed-3");
	read = { ...file, credential: { ...file.credential, access: "fresh", expires: Date.now() + 3_600_000 } };
	assert.equal((await memory())?.credential.access, "fresh");
	assert.equal(await radiusCredentials(async () => undefined)(), undefined);
});
