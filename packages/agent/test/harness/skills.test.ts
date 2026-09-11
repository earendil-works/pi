import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills, loadSourcedSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadSkills", () => {
	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
			BACKGROUND_CONTEXT,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills", BACKGROUND_CONTEXT);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
			BACKGROUND_CONTEXT,
		);
		await symlink(join(root, "actual"), join(root, "skills-link"));

		const { skills } = await loadSkills(env, "skills-link", BACKGROUND_CONTEXT);

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("preserves source info for sourced skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/example", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile(
			"user/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
			BACKGROUND_CONTEXT,
		);

		const { skills, diagnostics } = await loadSourcedSkills(
			env,
			[{ path: "user", source: { type: "user" as const } }],
			undefined,
			BACKGROUND_CONTEXT,
		);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				skill: {
					name: "example",
					description: "Example skill",
					content: "Use this skill.",
					filePath: join(root, "user/example/SKILL.md"),
					disableModelInvocation: false,
				},
				source: { type: "user" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.", BACKGROUND_CONTEXT);

		const { skills, diagnostics } = await loadSourcedSkills(
			env,
			[{ path: "user", source: { type: "user" as const } }],
			undefined,
			BACKGROUND_CONTEXT,
		);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "invalid_metadata",
				message: "description is required",
				path: join(root, "user/broken/SKILL.md"),
				source: { type: "user" },
			},
		]);
	});

	it("loads direct markdown children only from the root directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content", BACKGROUND_CONTEXT);
		await env.writeFile(
			"skills/nested/ignored.md",
			"---\ndescription: Ignored\n---\nIgnored content",
			BACKGROUND_CONTEXT,
		);

		const { skills } = await loadSkills(env, "skills", BACKGROUND_CONTEXT);

		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});

	it("ignores root markdown docs that do not declare skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested-skill", { recursive: true }, BACKGROUND_CONTEXT);
		await env.writeFile("skills/README.md", "# Shared skills\n\nDocumentation.", BACKGROUND_CONTEXT);
		await env.writeFile("skills/AGENTS.md", "# Agent notes\n\nDocumentation.", BACKGROUND_CONTEXT);
		await env.writeFile("skills/CLAUDE.md", "---\ndescription: [invalid\n---\n\nDocumentation.", BACKGROUND_CONTEXT);
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content", BACKGROUND_CONTEXT);
		await env.writeFile(
			"skills/nested-skill/SKILL.md",
			"---\nname: nested-skill\ndescription: Nested skill\n---\nNested content",
			BACKGROUND_CONTEXT,
		);

		const { skills, diagnostics } = await loadSkills(env, "skills", BACKGROUND_CONTEXT);

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name).sort()).toEqual(["nested-skill", "skills"]);
	});
});
