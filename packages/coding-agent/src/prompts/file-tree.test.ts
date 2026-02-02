import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildTreeFromPaths, formatTree, generateFileTree } from "./file-tree.js";

describe("buildTreeFromPaths", () => {
	it("should build a tree structure from flat file paths", () => {
		const paths = ["src/index.ts", "src/utils/helper.ts", "README.md"];
		const tree = buildTreeFromPaths(paths);

		// Should have root with src/ and README.md
		expect(tree.children).toHaveLength(2);
		expect(tree.children[0]?.name).toBe("src");
		expect(tree.children[0]?.type).toBe("directory");
		expect(tree.children[1]?.name).toBe("README.md");
		expect(tree.children[1]?.type).toBe("file");

		// src should have utils/ and index.ts (directories come first)
		const srcNode = tree.children[0];
		expect(srcNode?.children).toHaveLength(2);
		expect(srcNode?.children[0]?.name).toBe("utils");
		expect(srcNode?.children[0]?.type).toBe("directory");
		expect(srcNode?.children[1]?.name).toBe("index.ts");
		expect(srcNode?.children[1]?.type).toBe("file");

		// utils/ should have helper.ts
		const utilsNode = srcNode?.children[0];
		expect(utilsNode?.children).toHaveLength(1);
		expect(utilsNode?.children[0]?.name).toBe("helper.ts");
	});

	it("should sort directories before files, then alphabetically", () => {
		const paths = ["z.ts", "a/b.ts", "a/a.ts", "b/c.ts"];
		const tree = buildTreeFromPaths(paths);

		// Root should be: a/, b/, z.ts
		expect(tree.children.map((c) => c.name)).toEqual(["a", "b", "z.ts"]);

		// a/ should be: a.ts, b.ts
		const aNode = tree.children[0];
		expect(aNode?.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("formatTree", () => {
	it("should format tree with tab indentation", () => {
		const paths = ["src/index.ts", "README.md"];
		const tree = buildTreeFromPaths(paths);
		const formatted = formatTree(tree, { limit: 10 });

		const lines = formatted.split("\n").filter((l) => l.trim());
		expect(lines).toContain("README.md");
		expect(lines).toContain("src/");
		expect(lines).toContain("\tindex.ts");
	});

	it("should truncate when limit is reached", () => {
		const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
		const tree = buildTreeFromPaths(paths);
		const formatted = formatTree(tree, { limit: 3 });

		expect(formatted).toContain("[2 truncated]");
	});
});

describe("generateFileTree", () => {
	it("should return a formatted tree for current directory", async () => {
		const result = await generateFileTree({ cwd: ".", limit: 50 });

		expect(typeof result).toBe("string");
		// Should contain some expected files from this package
		expect(result.length).toBeGreaterThan(0);
	});

	it("should respect limit parameter", async () => {
		const result = await generateFileTree({ cwd: ".", limit: 5 });

		expect(typeof result).toBe("string");
		// With limit 5, should have truncation indicator
		expect(result).toContain("truncated");
	});

	it("should prefer git ls-files (exclude untracked files) when cwd is a git repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-file-tree-"));
		try {
			// Initialize a tiny git repo
			execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });

			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");

			execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

			// Commit with env-provided identity so this test doesn't depend on global git config
			const gitEnv = {
				...process.env,
				GIT_AUTHOR_NAME: "test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			};
			execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", env: gitEnv });

			// Create an untracked file that should NOT show up in the tree
			mkdirSync(join(dir, "untracked"), { recursive: true });
			writeFileSync(join(dir, "untracked", "secret.txt"), "nope\n", "utf8");

			const tree = await generateFileTree({ cwd: dir, limit: 200 });
			expect(tree).toContain("src/");
			expect(tree).toContain("tracked.ts");
			expect(tree).not.toContain("secret.txt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
