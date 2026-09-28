/**
 * Tests for MemoryStore.search (plus/src/extensions/memory/store.ts):
 * scoring order, multi-term semantics, empty query, and limit.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { MemoryStore } from "../../src/extensions/memory/store.ts";

async function seededStore(): Promise<MemoryStore> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-search-"));
	const store = MemoryStore.forDir(dir);
	await store.save({
		name: "Prefers pnpm",
		description: "package manager preference",
		type: "user",
		body: "Use pnpm everywhere.",
	});
	await store.save({
		name: "Auth flow",
		description: "JWT decision for the API",
		type: "project",
		body: "JWT beats sessions for stateless scaling.",
	});
	await store.save({
		name: "Dashboard link",
		description: "metrics dashboard",
		type: "reference",
		body: "https://metrics.example.com",
	});
	return store;
}

describe("MemoryStore.search", () => {
	it("ranks name matches above description and body matches", async () => {
		const store = await seededStore();
		// "auth" appears in a name; "metrics" only in a description/body.
		const byName = await store.search("auth");
		assert.equal(byName[0].name, "Auth flow");
		const byDesc = await store.search("metrics");
		assert.equal(byDesc[0].name, "Dashboard link");
	});

	it("requires every term to match somewhere", async () => {
		const store = await seededStore();
		// "auth" matches Auth flow only; "dashboard" matches Dashboard link only.
		assert.deepEqual(await store.search("auth dashboard"), []);
		// Both terms match Auth flow (name + body).
		const results = await store.search("auth jwt");
		assert.deepEqual(
			results.map((m) => m.name),
			["Auth flow"],
		);
	});

	it("is case-insensitive", async () => {
		const store = await seededStore();
		const results = await store.search("PNPM");
		assert.equal(results[0].name, "Prefers pnpm");
	});

	it("returns the first `limit` memories for an empty query", async () => {
		const store = await seededStore();
		const all = await store.search("");
		assert.equal(all.length, 3);
		const limited = await store.search("", 2);
		assert.equal(limited.length, 2);
	});

	it("respects the limit and returns no matches gracefully", async () => {
		const store = await seededStore();
		const results = await store.search("a", 2);
		assert.ok(results.length <= 2);
		assert.deepEqual(await store.search("zzzz-not-present"), []);
	});
});
