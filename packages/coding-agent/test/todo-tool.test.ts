import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { todoTool } from "../src/tools/todo.js";

describe("Todo tool", () => {
	beforeEach(async () => {
		process.env.MU_SESSION_ID = "session-test";
		process.env.MU_RUN_ID = "run-test";
		process.env.MU_TODO_PATH = await mkdtemp(join(tmpdir(), "mu-todo-tool-"));
	});

	it("create + list roundtrip", async () => {
		await todoTool.execute(
			"call-1",
			{
				action: "create",
				title: "Task A",
				list: "inbox",
				tags: ["x"],
				claim: true,
				body: "Notes",
			},
			undefined,
			undefined,
		);

		const listResult = await todoTool.execute(
			"call-2",
			{ action: "list", filters: { list: "inbox", assignment: "mine" } },
			undefined,
			undefined,
		);

		const text = listResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("Task A");
		expect(listResult.details?.todos).toHaveLength(1);
	});

	it("create_many creates multiple", async () => {
		const res = await todoTool.execute(
			"call-1",
			{
				action: "create_many",
				todos: [{ title: "A" }, { title: "B", list: "x" }],
			},
			undefined,
			undefined,
		);
		expect(res.details?.todos).toHaveLength(2);
	});
});
