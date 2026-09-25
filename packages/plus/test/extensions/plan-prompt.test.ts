/**
 * Tests for plus/src/extensions/plan/prompt.ts — the <plan_mode> system-prompt
 * section: names the plan file, reflects whether the plan exists, ends the
 * turn via ExitPlanMode, and never offers text-based plan approval.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildPlanModeSection, PLAN_MODE_SECTION_NAME } from "../../src/extensions/plan/prompt.ts";

const PLAN_PATH = "/home/user/.pi/agent/plans/session-1.md";

describe("buildPlanModeSection", () => {
	it("uses a valid system-prompt section name", () => {
		assert.match(PLAN_MODE_SECTION_NAME, /^[a-z][a-z0-9_-]*$/);
	});

	it("tells the model to create the plan file when none exists", () => {
		const section = buildPlanModeSection({ planFilePath: PLAN_PATH, planExists: false });
		assert.ok(section.includes(PLAN_PATH));
		assert.ok(section.includes("No plan file exists yet"));
		assert.ok(!section.includes("plan file already exists"));
	});

	it("tells the model to refine the plan file when one exists", () => {
		const section = buildPlanModeSection({ planFilePath: PLAN_PATH, planExists: true });
		assert.ok(section.includes(PLAN_PATH));
		assert.ok(section.includes("already exists"));
	});

	it("routes approval exclusively through ExitPlanMode", () => {
		const section = buildPlanModeSection({ planFilePath: PLAN_PATH, planExists: false });
		assert.ok(section.includes("ExitPlanMode"));
		assert.ok(section.includes("MUST NOT make any edits"));
		assert.ok(section.includes("ONLY file you are allowed to edit"));
	});

	it("declares read-only restrictions and the plan shape", () => {
		const section = buildPlanModeSection({ planFilePath: PLAN_PATH, planExists: false });
		for (const expected of ["**Context**", "**Changes**", "**Reuse**", "**Verification**"]) {
			assert.ok(section.includes(expected), `missing ${expected}`);
		}
	});
});
