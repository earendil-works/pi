import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FileMemoryStore,
	formatMemoriesBlock,
	InMemoryMemoryStore,
	type MemoryStore,
} from "../src/harness/memory/memory-store.ts";

function seedStore(store: MemoryStore): Promise<void> {
	return Promise.all([
		store.save({ content: "Use pnpm for this repo.", cwd: "/repo/a", tags: ["tooling"] }),
		store.save({ content: "The build is slow; cache it.", cwd: "/repo/a", tags: ["build"] }),
		store.save({ content: "Other project note.", cwd: "/elsewhere", tags: [] }),
	]);
}

describe("InMemoryMemoryStore", () => {
	it("saves and lists entries sorted by updatedAt", async () => {
		const store = new InMemoryMemoryStore();
		await seedStore(store);
		const all = await store.list();
		expect(all).toHaveLength(3);
		expect(all.map((e) => e.content)).toContain("Use pnpm for this repo.");
		expect(all[0].updatedAt).toBeGreaterThanOrEqual(all[all.length - 1].updatedAt);
	});

	it("filters by cwd prefix", async () => {
		const store = new InMemoryMemoryStore();
		await seedStore(store);
		const inRepo = await store.list({ cwd: "/repo/a" });
		expect(inRepo).toHaveLength(2);
		const subdir = await store.list({ cwd: "/repo/a/src" });
		expect(subdir).toHaveLength(2); // prefix match on stored cwd
		const elsewhere = await store.list({ cwd: "/repo/b" });
		expect(elsewhere).toHaveLength(0);
	});

	it("filters by keywords (content and tags)", async () => {
		const store = new InMemoryMemoryStore();
		await seedStore(store);
		const byTag = await store.list({ keywords: ["tooling"] });
		expect(byTag.map((e) => e.content)).toEqual(["Use pnpm for this repo."]);
		const byContent = await store.list({ keywords: ["slow"] });
		expect(byContent).toHaveLength(1);
	});

	it("deletes entries", async () => {
		const store = new InMemoryMemoryStore();
		await seedStore(store);
		const all = await store.list();
		await store.delete(all[0].id);
		expect(await store.list()).toHaveLength(2);
	});

	it("respects limit", async () => {
		const store = new InMemoryMemoryStore();
		await seedStore(store);
		expect(await store.list({ limit: 2 })).toHaveLength(2);
	});
});

describe("FileMemoryStore", () => {
	it("persists entries across instances", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
		try {
			const a = new FileMemoryStore(dir);
			await a.save({ content: "Remember this.", cwd: "/repo/a" });

			const b = new FileMemoryStore(dir);
			const entries = await b.list({ cwd: "/repo/a" });
			expect(entries).toHaveLength(1);
			expect(entries[0].content).toBe("Remember this.");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips corrupted files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
		try {
			const store = new FileMemoryStore(dir);
			await store.save({ content: "Valid", cwd: "/x" });
			await writeFile(join(dir, "memories", "broken.json"), "not json", "utf8");
			const entries = await store.list();
			expect(entries).toHaveLength(1);
			expect(entries[0].content).toBe("Valid");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("deletes the backing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
		try {
			const store = new FileMemoryStore(dir);
			const saved = await store.save({ content: "bye", cwd: "/x" });
			await store.delete(saved.id);
			expect(await store.list()).toHaveLength(0);
			await expect(readFile(join(dir, "memories", `${saved.id}.json`))).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("formatMemoriesBlock", () => {
	it("returns undefined for no memories", () => {
		expect(formatMemoriesBlock([])).toBeUndefined();
	});

	it("renders a bullet list under a heading", () => {
		const block = formatMemoriesBlock([
			{ id: "1", content: "First fact", cwd: "/a", createdAt: 1, updatedAt: 1 },
			{ id: "2", content: "Second fact", cwd: "/a", createdAt: 2, updatedAt: 2 },
		]);
		expect(block).toContain("## Project memories");
		expect(block).toContain("- First fact");
		expect(block).toContain("- Second fact");
	});
});
