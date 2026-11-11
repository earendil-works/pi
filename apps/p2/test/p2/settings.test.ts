// The Settings sheet's contract (plugins/settings): settings.json changed by some of its top-level settings, owner only.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Settings } from "../../plugins/settings/contract.ts";
import { expectChord, startFixture } from "./helpers.ts";

test("Settings sets and removes top-level settings, keeps the others, and refuses invalid ones", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const file = join(fixture.dataDir, "settings.json");
	const read = () => JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ detail: 2, ownerName: "Mario", thinkingLevel: "low" }));
	const ref = fixture.browser().hold(Settings, {}, BACKGROUND_CONTEXT);
	await whenLive(ref);
	// The file written before the hold may still be loading.
	for (let tries = 0; ref.settings.value.ownerName !== "Mario" && tries < 100; tries++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(ref.error.value, null);

	await ref.update(
		{
			set: { detail: 4, stream: { transport: "sse", timeoutMs: 1000, maxRetries: undefined } },
			unset: ["ownerName"],
		},
		BACKGROUND_CONTEXT,
	);
	// The answer follows its state: the page holds the saved settings when the call resolves.
	assert.deepEqual(ref.settings.value, {
		detail: 4,
		thinkingLevel: "low",
		stream: { transport: "sse", timeoutMs: 1000 },
	});
	assert.deepEqual(read(), ref.settings.value);

	// The server merges into the file as it is now, not into the page's copy.
	writeFileSync(file, JSON.stringify({ ...read(), codemode: false }));
	await ref.update({ set: { cacheWarming: "off" }, unset: ["stream"] }, BACKGROUND_CONTEXT);
	assert.deepEqual(read(), { detail: 4, thinkingLevel: "low", codemode: false, cacheWarming: "off" });

	for (const set of [{ detail: 9 }, { unknownSetting: true }, { ownerName: "<script>" }, "detail"])
		await assert.rejects(ref.update({ set, unset: [] }, BACKGROUND_CONTEXT), `refuses ${JSON.stringify(set)}`);
	assert.deepEqual(read(), { detail: 4, thinkingLevel: "low", codemode: false, cacheWarming: "off" });

	const guest = fixture.as({
		kind: "guest",
		id: "g1",
		name: "Guest",
		home: "s1",
		sessions: { s1: "full" },
		revision: 1,
	});
	await expectChord(whenLive(guest.hold(Settings, {}, BACKGROUND_CONTEXT)), "forbidden");
});
