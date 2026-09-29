import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

async function sourceGraph(entry: string): Promise<Set<string>> {
	const visited = new Set<string>();
	const pending = [resolve(sourceRoot, entry)];
	while (pending.length > 0) {
		const path = pending.pop()!;
		if (visited.has(path)) continue;
		visited.add(path);
		const source = await readFile(path, "utf8");
		expect(source, `${path} imports a Node built-in`).not.toMatch(/(?:from\s+|import\s*)["']node:/);
		// Type-only imports are erased and load nothing.
		for (const match of source.matchAll(/\b(import|export)(\s+type\b)?[^;"']*?(?:from\s*)?["'](\.[^"']+)["']/g)) {
			if (match[2] === undefined) pending.push(resolve(dirname(path), match[3]));
		}
	}
	return visited;
}

describe("durable storage runtime boundaries", () => {
	it("keeps the package root limited to portable core storage", async () => {
		const graph = await sourceGraph("index.ts");
		expect([...graph].some((path) => path.includes("/env/"))).toBe(false);
		expect([...graph].some((path) => path.includes("/storage/jsonl/"))).toBe(false);
		expect([...graph].some((path) => path.includes("/storage/sqlite/"))).toBe(false);
	});

	it("keeps the portable SQLite subpath free of Node imports", async () => {
		const graph = await sourceGraph("storage/sqlite/index.ts");
		expect([...graph].some((path) => path.endsWith("/storage/sqlite/node.ts"))).toBe(false);
	});

	it("keeps the portable environment subpath free of Node imports", async () => {
		const graph = await sourceGraph("env/index.ts");
		expect([...graph].some((path) => path.endsWith("/env/node.ts"))).toBe(false);
	});

	it("keeps the portable JSONL subpath free of Node imports", async () => {
		const graph = await sourceGraph("storage/jsonl/index.ts");
		expect([...graph].some((path) => path.endsWith("/storage/jsonl/node.ts"))).toBe(false);
		expect([...graph].some((path) => path.endsWith("/env/node.ts"))).toBe(false);
	});
});
