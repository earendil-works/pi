/**
 * Tests for the memory store (plus/src/extensions/memory/store.ts): file
 * layout, frontmatter round-trip, slug sanitization, index caps, corrupt-file
 * tolerance, and write concurrency.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	INDEX_FILE,
	MAX_INDEX_BYTES,
	MAX_INDEX_LINES,
	MemoryStore,
	projectKeyFor,
} from "../../src/extensions/memory/store.ts";

function tempStore(): { dir: string; store: MemoryStore } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-store-"));
	return { dir, store: MemoryStore.forDir(dir) };
}

describe("projectKeyFor", () => {
	it("encodes cwd the same way as the session-manager session dirs", () => {
		assert.equal(projectKeyFor("/a/b"), "--a-b--");
		assert.equal(projectKeyFor("/Users/kangtong/Documents/x/pi"), "--Users-kangtong-Documents-x-pi--");
	});

	it("maps colons to dashes", () => {
		assert.equal(projectKeyFor("/a/b:c"), "--a-b-c--");
	});
});

describe("MemoryStore save/list/get", () => {
	it("round-trips a memory with frontmatter", async () => {
		const { store } = tempStore();
		const saved = await store.save({
			name: "Prefers pnpm",
			description: "User prefers pnpm over npm",
			type: "user",
			body: "Always use pnpm for installs.\n\n**Why:** faster monorepo installs.\n",
		});
		assert.equal(saved.fileName, "prefers-pnpm.md");

		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "Prefers pnpm");
		assert.equal(listed[0].type, "user");
		assert.equal(listed[0].body.includes("Always use pnpm"), true);

		const got = await store.get("prefers-pnpm.md");
		assert.equal(got?.description, "User prefers pnpm over npm");
	});

	it("serializes valid frontmatter to disk", async () => {
		const { dir, store } = tempStore();
		await store.save({ name: "Auth decision", description: "JWT over sessions", type: "project", body: "Use JWT." });
		const raw = fs.readFileSync(path.join(dir, "auth-decision.md"), "utf-8");
		assert.ok(raw.startsWith("---\n"));
		assert.ok(raw.includes("name: Auth decision"));
		assert.ok(raw.includes("type: project"));
	});

	it("defaults an invalid frontmatter type to reference", async () => {
		const { dir, store } = tempStore();
		fs.writeFileSync(path.join(dir, "weird.md"), "---\nname: Weird\ndescription: d\ntype: banana\n---\n\nbody\n");
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].type, "reference");
	});

	it("skips files without a usable frontmatter name", async () => {
		const { dir, store } = tempStore();
		await store.save({ name: "Good", description: "d", type: "project", body: "b" });
		fs.writeFileSync(path.join(dir, "corrupt.md"), "just some prose, no frontmatter");
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "Good");
	});

	it("overwriting the same name updates in place and keeps one index line", async () => {
		const { store } = tempStore();
		await store.save({ name: "Setup", description: "v1", type: "project", body: "first" });
		await store.save({ name: "Setup", description: "v2", type: "project", body: "second" });
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].body, "second");
		const index = await store.readIndex();
		assert.equal(index.split("\n").filter((l) => l.startsWith("- [")).length, 1);
	});

	it("rejects names with path separators and never writes outside the dir", async () => {
		const { dir, store } = tempStore();
		await assert.rejects(() => store.save({ name: "../evil", description: "d", type: "user", body: "b" }));
		await assert.rejects(() => store.save({ name: "a/b", description: "d", type: "user", body: "b" }));
		const entries = fs.readdirSync(dir);
		assert.deepEqual(entries, []);
	});

	it("disambiguates collisions between different names slugging to the same file", async () => {
		const { store } = tempStore();
		const first = await store.save({ name: "a b", description: "d1", type: "user", body: "one" });
		const second = await store.save({ name: "a-b", description: "d2", type: "user", body: "two" });
		assert.notEqual(first.fileName, second.fileName);
		const listed = await store.list();
		assert.equal(listed.length, 2);
	});

	it("remove deletes the file and its index line", async () => {
		const { store } = tempStore();
		const saved = await store.save({ name: "Temp", description: "d", type: "project", body: "b" });
		assert.equal(await store.remove(saved.fileName), true);
		assert.equal(await store.remove(saved.fileName), false);
		assert.deepEqual(await store.list(), []);
		const index = await store.readIndex();
		assert.equal(index.includes("Temp"), false);
	});

	it("refuses file names outside the store dir", async () => {
		const { store } = tempStore();
		assert.equal(await store.get("../escape.md"), null);
		assert.equal(await store.remove("../escape.md"), false);
	});

	it("caps the index at MAX_INDEX_LINES and MAX_INDEX_BYTES", async () => {
		const { store } = tempStore();
		const count = MAX_INDEX_LINES + 20;
		for (let i = 0; i < count; i++) {
			await store.save({
				name: `Memory ${String(i).padStart(4, "0")}`,
				description: `d${i}`,
				type: "project",
				body: "b",
			});
		}
		const listed = await store.list();
		assert.equal(listed.length, count);
		const index = await store.readIndex();
		const entryLines = index.split("\n").filter((l) => l.startsWith("- ["));
		assert.ok(entryLines.length <= MAX_INDEX_LINES);
		assert.ok(Buffer.byteLength(index, "utf-8") <= MAX_INDEX_BYTES);
	});

	it("serializes concurrent saves", async () => {
		const { store } = tempStore();
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				store.save({ name: `Concurrent ${i}`, description: "d", type: "project", body: `body ${i}` }),
			),
		);
		const listed = await store.list();
		assert.equal(listed.length, 20);
	});

	it("rebuilds the index after remove so MEMORY.md stays consistent", async () => {
		const { store } = tempStore();
		const a = await store.save({ name: "Alpha", description: "first", type: "project", body: "b" });
		await store.save({ name: "Beta", description: "second", type: "user", body: "b" });
		await store.remove(a.fileName);
		const index = await store.readIndex();
		assert.ok(index.includes("Beta"));
		assert.ok(!index.includes("Alpha"));
		assert.ok(index.startsWith("# Memory index"));
	});

	it("readIndex is empty when no index exists and ignores non-index reads", async () => {
		const { store } = tempStore();
		assert.equal(await store.readIndex(), "");
		assert.equal((await store.list()).length, 0);
		assert.ok(INDEX_FILE.endsWith(".md"));
	});
});
