import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { todoTool } from "../src/tools/todo.js";

describe("Todo tool output (no hidden system_reminder)", () => {
	it("does not append <system_reminder> tags", async () => {
		process.env.MU_SESSION_ID = "session-test";
		process.env.MU_RUN_ID = "run-test";
		process.env.MU_TODO_PATH = await mkdtemp(join(tmpdir(), "mu-todo-reminder-"));

		const result = await todoTool.execute(
			"call-1",
			{ action: "create", title: "Do the thing", claim: true, body: "Notes" },
			undefined,
			undefined,
		);

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("Created:");
		expect(text).not.toContain("system_reminder");
	});
});
