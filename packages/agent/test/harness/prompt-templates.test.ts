import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	formatPromptTemplateInvocation,
	loadPromptTemplates,
	loadSourcedPromptTemplates,
} from "../../src/harness/prompt-templates.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadPromptTemplates", () => {
	it("loads markdown templates non-recursively from one or more dirs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("a/nested", { recursive: true });
		await env.createDir("b", { recursive: true });
		await env.writeFile("a/one.md", "---\ndescription: One template\n---\nHello $1");
		await env.writeFile("a/nested/ignored.md", "Ignored");
		await env.writeFile("b/two.md", "First line description\nBody");

		const { promptTemplates, diagnostics } = await loadPromptTemplates(env, ["a", "b"]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{ name: "one", description: "One template", content: "Hello $1" },
			{ name: "two", description: "First line description", content: "First line description\nBody" },
		]);
	});

	it("preserves source info for sourced prompt templates", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("prompts", { recursive: true });
		await env.writeFile("prompts/example.md", "---\ndescription: Example\n---\nExample body");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "prompts", source: { type: "project" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(promptTemplates).toEqual([
			{
				promptTemplate: { name: "example", description: "Example", content: "Example body" },
				source: { type: "project" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("broken.md", "---\ndescription: [unterminated\n---\nBody");

		const { promptTemplates, diagnostics } = await loadSourcedPromptTemplates(env, [
			{ path: "broken.md", source: { type: "user" as const } },
		]);

		expect(promptTemplates).toEqual([]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			type: "warning",
			path: join(root, "broken.md"),
			source: { type: "user" },
		});
	});

	it("loads explicit markdown files and symlinked files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.writeFile("target.md", "---\ndescription: Target\n---\nTarget body");
		await symlink(join(root, "target.md"), join(root, "link.md"));

		const { promptTemplates } = await loadPromptTemplates(env, ["target.md", "link.md"]);

		expect(promptTemplates).toEqual([
			{ name: "target", description: "Target", content: "Target body" },
			{ name: "link", description: "Target", content: "Target body" },
		]);
	});
});

describe("formatPromptTemplateInvocation", () => {
	it("substitutes command arguments", () => {
		const content = "$1 $" + "{@:2} $ARGUMENTS";
		expect(formatPromptTemplateInvocation({ name: "one", content }, ["hello world", "test"])).toBe(
			"hello world test hello world test",
		);
	});
});
