import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath, isLocalPath } from "../src/utils/paths.js";

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

describe("isLocalPath", () => {
	it("returns true for bare names", () => {
		expect(isLocalPath("my-package")).toBe(true);
	});

	it("returns true for relative paths", () => {
		expect(isLocalPath("./foo")).toBe(true);
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
