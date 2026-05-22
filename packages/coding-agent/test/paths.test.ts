import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath, getCwdRelativePath, isLocalPath, normalizePath, resolvePath } from "../src/utils/paths.ts";

let tempDir: string;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function createTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "pi-paths-"));
	return tempDir;
}

describe("canonicalizePath", () => {
	it("returns the real path for a regular file", () => {
		const dir = createTempDir();
		const file = join(dir, "file.txt");
		writeFileSync(file, "hello");
		expect(canonicalizePath(file)).toBe(realpathSync(file));
	});

	it("resolves symlinks to their targets", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "hello");
		symlinkSync(target, link);
		expect(canonicalizePath(link)).toBe(realpathSync(target));
	});

	it("resolves directory symlinks", () => {
		const dir = createTempDir();
		const targetDir = join(dir, "target-dir");
		const linkDir = join(dir, "link-dir");
		mkdirSync(targetDir);
		symlinkSync(targetDir, linkDir, "dir");
		expect(canonicalizePath(linkDir)).toBe(realpathSync(targetDir));
	});

	it("falls back to the raw path when the target does not exist", () => {
		const dir = createTempDir();
		const nonexistent = join(dir, "no-such-file");
		expect(canonicalizePath(nonexistent)).toBe(nonexistent);
	});

	it("falls back to the raw path for a dangling symlink", () => {
		const dir = createTempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		// Create a symlink whose target does not exist.
		symlinkSync(target, link);
		// realpathSync would throw, so canonicalizePath returns the link path.
		expect(canonicalizePath(link)).toBe(link);
	});
});

describe("getCwdRelativePath", () => {
	it("keeps cwd-relative names that start with dots", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..config", "AGENTS.md"), cwd)).toBe(join("..config", "AGENTS.md"));
	});

	it("rejects parent-directory traversals", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(getCwdRelativePath(join(cwd, "..", "AGENTS.md"), cwd)).toBeUndefined();
	});
});

describe("resolvePath", () => {
	it("expands only home tilde shortcuts", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(normalizePath("~")).toBe(homedir());
		expect(normalizePath("~/file.txt")).toBe(join(homedir(), "file.txt"));
		expect(resolvePath("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
		expect(normalizePath("~draft.md")).toBe("~draft.md");
	});

	it("resolves relative paths against the base directory", () => {
		const cwd = join(tmpdir(), "pi-paths-cwd");
		expect(resolvePath("subdir/file.txt", cwd)).toBe(resolve(cwd, "subdir/file.txt"));
		expect(resolvePath("subdir/file.txt", pathToFileURL(cwd).href)).toBe(resolve(cwd, "subdir/file.txt"));
	});

	it("accepts file URLs", () => {
		const dir = createTempDir();
		const filePath = join(dir, "file with spaces.txt");
		expect(resolvePath(pathToFileURL(filePath).href, join(dir, "base"))).toBe(resolve(filePath));
	});

	it("throws for invalid file URLs", () => {
		expect(() => resolvePath("file:///%E0%A4%A")).toThrow();
	});

	it("preserves POSIX absolute paths with literal percent sequences", () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = createTempDir();
		for (const filePath of [join(dir, "report%2026.md"), join(dir, "foo%2Fbar"), join(dir, "malformed%A.md")]) {
			expect(resolvePath(filePath, join(dir, "base"))).toBe(resolve(filePath));
		}
	});

	it("does not treat Windows file URL pathname strings as native paths", () => {
		if (process.platform !== "win32") {
			return;
		}

		const dir = createTempDir();
		const filePath = join(dir, "dir", "SKILL.md");
		const pathname = pathToFileURL(filePath).pathname;
		expect(pathname).toMatch(/^\/[A-Za-z]:/);
		expect(resolvePath(pathname, "E:\\project")).toBe(resolve(pathname));
	});
});

describe("isLocalPath", () => {
	it("returns true for bare names", () => {
		expect(isLocalPath("my-package")).toBe(true);
	});

	it("returns true for relative paths", () => {
		expect(isLocalPath("./foo")).toBe(true);
	});

	it("returns true for file URLs", () => {
		expect(isLocalPath("file:///tmp/foo")).toBe(true);
	});

	it("returns false for npm: protocol", () => {
		expect(isLocalPath("npm:package")).toBe(false);
	});

	it("returns false for git: protocol", () => {
		expect(isLocalPath("git://repo")).toBe(false);
	});

	it("returns false for https: protocol", () => {
		expect(isLocalPath("https://example.com")).toBe(false);
	});
});
