import { describe, expect, it } from "vitest";
import {
	coerceTodoFrontmatter,
	formatTodoMarkdown,
	parseFrontmatterMarkdown,
	parseTodoMarkdownOrThrow,
} from "../src/todos/todo-file.js";
import { resolveTodoRootDir } from "../src/todos/todo-path.js";

describe("todo file format", () => {
	it("parses YAML front-matter and preserves markdown body", () => {
		const md =
			"---\n" +
			"id: deadbeef\n" +
			"title: Test\n" +
			"list: inbox\n" +
			"tags: [agent, todos]\n" +
			"status: open\n" +
			"created_at: '2026-02-08T02:00:00.000Z'\n" +
			"updated_at: '2026-02-08T02:10:00.000Z'\n" +
			"assigned_to_session: session-uuid\n" +
			"assigned_to_run: run-uuid\n" +
			"---\n" +
			"\n" +
			"Notes line 1\n" +
			"Notes line 2\n";

		const parsed = parseFrontmatterMarkdown(md);
		expect(parsed).not.toBeNull();
		expect(parsed?.body).toContain("Notes line 1");

		const fm = coerceTodoFrontmatter(parsed?.frontmatter);
		expect(fm.id).toBe("deadbeef");
		expect(fm.tags).toEqual(["agent", "todos"]);
	});

	it("formats markdown with YAML front-matter fences", () => {
		const todo = parseTodoMarkdownOrThrow(
			"---\n" +
				"id: deadbeef\n" +
				"title: Test\n" +
				"list: inbox\n" +
				"status: open\n" +
				"created_at: '2026-02-08T02:00:00.000Z'\n" +
				"updated_at: '2026-02-08T02:10:00.000Z'\n" +
				"---\n" +
				"\nBody\n",
		);

		const md = formatTodoMarkdown(todo);
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain("\n---\n");
		expect(md).toContain("title: Test");
		expect(md).toContain("\nBody\n");
	});
});

describe("todo storage path resolution", () => {
	it("defaults to <repoRoot>/.mu/todos", () => {
		const dir = resolveTodoRootDir({ cwd: "/repo/sub", repoRoot: "/repo" });
		expect(dir).toBe("/repo/.mu/todos");
	});

	it("uses MU_TODO_PATH absolute override", () => {
		const dir = resolveTodoRootDir({ cwd: "/repo", repoRoot: "/repo", envTodoPath: "/tmp/my-todos" });
		expect(dir).toBe("/tmp/my-todos");
	});

	it("resolves MU_TODO_PATH relative to repoRoot when available", () => {
		const dir = resolveTodoRootDir({ cwd: "/repo/sub", repoRoot: "/repo", envTodoPath: "state/todos" });
		expect(dir).toBe("/repo/state/todos");
	});

	it("resolves MU_TODO_PATH relative to cwd when repoRoot missing", () => {
		const dir = resolveTodoRootDir({ cwd: "/work", repoRoot: null, envTodoPath: "state/todos" });
		expect(dir).toBe("/work/state/todos");
	});
});
