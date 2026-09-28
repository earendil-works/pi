/**
 * Tests for plus/src/extensions/tasks/index.ts buildTasksSection — the
 * <tasks> system-prompt section: nudges the model to use the Task* tools
 * proactively and surfaces the session's current task list when non-empty.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildTasksSection, TASKS_SECTION_NAME } from "../../src/extensions/tasks/index.ts";
import type { Task } from "../../src/extensions/tasks/store.ts";

function task(overrides: Partial<Task>): Task {
	return {
		id: "1",
		subject: "Fix auth bug",
		description: "details",
		status: "pending",
		blocks: [],
		blockedBy: [],
		...overrides,
	};
}

describe("buildTasksSection", () => {
	it("uses a valid system-prompt section name", () => {
		assert.match(TASKS_SECTION_NAME, /^[a-z][a-z0-9_-]*$/);
	});

	it("nudges proactive task creation for multi-step work", () => {
		const section = buildTasksSection([]);
		assert.ok(section.includes("TaskCreate"));
		assert.ok(section.includes("in_progress"));
		assert.ok(section.includes("completed"));
		assert.ok(section.includes("blocks/blockedBy"));
	});

	it("skips trivial single-step requests", () => {
		const section = buildTasksSection([]);
		assert.ok(section.includes("trivial single-step"));
	});

	it("omits the list when there are no tasks", () => {
		const section = buildTasksSection([]);
		assert.ok(!section.includes("Current tasks"));
	});

	it("lists current tasks with status when non-empty", () => {
		const section = buildTasksSection([
			task({ id: "1", subject: "Fix auth bug", status: "in_progress" }),
			task({ id: "2", subject: "Add tests", status: "pending", blockedBy: ["1"] }),
		]);
		assert.ok(section.includes("Current tasks:"));
		assert.ok(section.includes("#1 [in_progress] Fix auth bug"));
		assert.ok(section.includes("#2 [pending] Add tests"));
		assert.ok(section.includes("[blocked by #1]"));
	});
});
