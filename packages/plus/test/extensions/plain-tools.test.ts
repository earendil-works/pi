/**
 * Tests for pi-plus-plain-tools: the three tool-block background tokens
 * (toolPendingBg / toolSuccessBg / toolErrorBg) render without a fill, other
 * background tokens are unaffected, and the patch is idempotent.
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { stripToolBlockBackgrounds } from "../../src/extensions/plain-tools/index.ts";

beforeAll(() => {
	initTheme("dark");
	stripToolBlockBackgrounds();
});

describe("plain tool blocks", () => {
	it("strips the fill from all three tool-block tokens", () => {
		assert.equal(theme.bg("toolPendingBg", "text"), "text");
		assert.equal(theme.bg("toolSuccessBg", "text"), "text");
		assert.equal(theme.bg("toolErrorBg", "text"), "text");
	});

	it("keeps other background tokens painted", () => {
		assert.notEqual(theme.bg("userMessageBg", "text"), "text");
		assert.notEqual(theme.bg("selectedBg", "text"), "text");
	});

	it("keeps foreground colors untouched", () => {
		assert.notEqual(theme.fg("success", "text"), "text");
	});

	it("patch is idempotent", () => {
		stripToolBlockBackgrounds();
		assert.equal(theme.bg("toolSuccessBg", "text"), "text");
	});
});
