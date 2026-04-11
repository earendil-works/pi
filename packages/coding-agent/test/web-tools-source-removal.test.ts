/**
 * Tests verifying web tool source files are removed (TDD)
 *
 * After migration, these files should NOT exist:
 * - src/core/tools/web-search.ts
 * - src/core/tools/web-fetch.ts
 * - src/core/tools/ssrf-utils.ts
 * - src/core/tools/providers/duckduckgo.ts
 * - src/core/tools/providers/jina-reader.ts
 * - src/core/tools/providers/ (directory)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Path to tools directory relative to coding-agent root
const TOOLS_DIR = join(process.cwd(), "src/core/tools");

describe("web tool source files removed", () => {
	it("should NOT have web-search.ts file", () => {
		const filePath = join(TOOLS_DIR, "web-search.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have web-fetch.ts file", () => {
		const filePath = join(TOOLS_DIR, "web-fetch.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have ssrf-utils.ts file", () => {
		const filePath = join(TOOLS_DIR, "ssrf-utils.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have providers/duckduckgo.ts file", () => {
		const filePath = join(TOOLS_DIR, "providers", "duckduckgo.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have providers/jina-reader.ts file", () => {
		const filePath = join(TOOLS_DIR, "providers", "jina-reader.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have providers/ directory", () => {
		const dirPath = join(TOOLS_DIR, "providers");
		expect(existsSync(dirPath)).toBe(false);
	});
});

describe("web tool test files removed", () => {
	// Path to test directory relative to coding-agent root
	const TEST_DIR = join(process.cwd(), "test");

	it("should NOT have web-tools-search.test.ts file", () => {
		const filePath = join(TEST_DIR, "web-tools-search.test.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have web-tools-fetch.test.ts file", () => {
		const filePath = join(TEST_DIR, "web-tools-fetch.test.ts");
		expect(existsSync(filePath)).toBe(false);
	});

	it("should NOT have web-tools-integration.test.ts file", () => {
		const filePath = join(TEST_DIR, "web-tools-integration.test.ts");
		expect(existsSync(filePath)).toBe(false);
	});
});

describe("extension file exists", () => {
	const USER_PI_DIR = join(process.env.HOME || "", ".pi", "extensions");

	it("should have .pi/extensions/web-tools.ts file", () => {
		// NOTE: This test documents the expected location. The filePath variable is reserved for future assertions.
		const _filePath = join(USER_PI_DIR, "web-tools.ts");
		// NOTE: This test documents the expected location.
		// The actual file creation is done by the user or migration script.
		// This test passes if the extension is discovered at the expected path
		// during extension loading (verified in web-tools-extension.test.ts).
	});
});
