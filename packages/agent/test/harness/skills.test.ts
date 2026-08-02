import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills, loadSourcedSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadSkills", () => {
	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true });
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
				userInvocable: true,
			},
		]);
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true });
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);
		await symlink(join(root, "actual"), join(root, "skills-link"));

		const { skills } = await loadSkills(env, "skills-link");

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("preserves source info for sourced skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/example", { recursive: true });
		await env.writeFile(
			"user/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				skill: {
					name: "example",
					description: "Example skill",
					content: "Use this skill.",
					filePath: join(root, "user/example/SKILL.md"),
					disableModelInvocation: false,
					userInvocable: true,
				},
				source: { type: "user" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true });
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\n# Broken, no usable paragraph");

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

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
		await env.createDir("skills/nested", { recursive: true });
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content");
		await env.writeFile("skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content");

		const { skills } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});

	it("falls back to the first body paragraph when description is omitted", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/fallback", { recursive: true });
		await env.writeFile(
			"skills/fallback/SKILL.md",
			"---\nname: fallback\n---\n# Fallback Skill\n\nFirst paragraph\nspanning two lines.\n\nSecond paragraph.",
		);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("First paragraph spanning two lines.");
	});

	it("coerces Claude Code boolean frontmatter values", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cases: Array<[string, boolean]> = [
			["yes", true],
			["on", true],
			["1", true],
			["YES", true],
			["True", true],
			["no", false],
			["off", false],
			["0", false],
		];
		for (const [index, [value]] of cases.entries()) {
			await env.createDir(`skills/case-${index}`, { recursive: true });
			await env.writeFile(
				`skills/case-${index}/SKILL.md`,
				`---\ndescription: Coercion test\ndisable-model-invocation: ${value}\n---\nBody.`,
			);
		}

		for (const [index, [, expected]] of cases.entries()) {
			const { skills, diagnostics } = await loadSkills(env, `skills/case-${index}`);
			expect(diagnostics).toEqual([]);
			expect(skills[0]?.disableModelInvocation).toBe(expected);
		}
	});

	it("warns and defaults on invalid boolean frontmatter values", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/invalid", { recursive: true });
		await env.writeFile(
			"skills/invalid/SKILL.md",
			"---\ndescription: Invalid boolean\ndisable-model-invocation: maybe\n---\nBody.",
		);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(skills[0]?.disableModelInvocation).toBe(false);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "invalid_metadata",
				message: 'invalid boolean value for "disable-model-invocation"',
				path: join(root, "skills/invalid/SKILL.md"),
			},
		]);
	});

	it("parses Claude Code user-invocable, when_to_use, and argument-hint fields", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/claude", { recursive: true });
		await env.writeFile(
			"skills/claude/SKILL.md",
			`---
name: claude
description: Claude field test
when_to_use: Use when testing Claude compatibility.
argument-hint: [issue-number]
user-invocable: false
---
Body.`,
		);

		const { skills, diagnostics } = await loadSkills(env, "skills");

		expect(diagnostics).toEqual([]);
		expect(skills[0]?.userInvocable).toBe(false);
		expect(skills[0]?.whenToUse).toBe("Use when testing Claude compatibility.");
		expect(skills[0]?.argumentHint).toBe("[issue-number]");
	});
});
