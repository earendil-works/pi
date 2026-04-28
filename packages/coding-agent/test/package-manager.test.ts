import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ProgressEvent, type ResolvedResource } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
}

class MockSpawnedProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();

	kill(): boolean {
		this.emit("close", null, "SIGTERM");
		return true;
	}
}

// Helper to check if a resource is enabled
const isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !r.enabled
		: normalizedPath.includes(normalizedMatch) && !r.enabled;
};

describe("DefaultPackageManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolve", () => {
		it("should return no package-sourced paths when no sources configured", async () => {
			const result = await packageManager.resolve();
			expect(result.extensions).toEqual([]);
			expect(result.prompts).toEqual([]);
			expect(result.themes).toEqual([]);
			expect(result.skills.every((r) => r.metadata.source === "auto" && r.metadata.origin === "top-level")).toBe(
				true,
			);
		});

		it("should resolve local extension paths from settings", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-extension.ts");
			writeFileSync(extPath, "export default function() {}");
			settingsManager.setExtensionPaths(["extensions/my-extension.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should resolve skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(
				skillFile,
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			// Skills with SKILL.md are returned as file paths
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover root markdown skills from .pi skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(
				skillFile,
				`---
name: single-file
description: A root markdown skill
---
Content`,
			);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should resolve project paths relative to .pi", async () => {
			const extDir = join(tempDir, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "project-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setProjectExtensionPaths(["extensions/project-ext.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should auto-discover user prompts with overrides", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "auto.md");
			writeFileSync(promptPath, "Auto prompt");

			settingsManager.setPromptTemplatePaths(["!prompts/auto.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve symlinked user and project resources once", async () => {
			const sharedDir = join(tempDir, "shared-resources");
			const sharedExtensionsDir = join(sharedDir, "extensions");
			const sharedSkillsDir = join(sharedDir, "skills");
			const sharedPromptsDir = join(sharedDir, "prompts");
			const sharedThemesDir = join(sharedDir, "themes");
			mkdirSync(sharedExtensionsDir, { recursive: true });
			mkdirSync(sharedSkillsDir, { recursive: true });
			mkdirSync(sharedPromptsDir, { recursive: true });
			mkdirSync(sharedThemesDir, { recursive: true });

			writeFileSync(join(sharedExtensionsDir, "shared.ts"), "export default function() {}");
			mkdirSync(join(sharedSkillsDir, "shared-skill"), { recursive: true });
			writeFileSync(
				join(sharedSkillsDir, "shared-skill", "SKILL.md"),
				`---
name: shared-skill
description: Shared skill
---
Content`,
			);
			writeFileSync(join(sharedPromptsDir, "shared.md"), "Shared prompt");
			writeFileSync(join(sharedThemesDir, "shared.json"), JSON.stringify({ name: "shared-theme" }));

			mkdirSync(join(agentDir), { recursive: true });
			mkdirSync(join(tempDir, ".pi"), { recursive: true });
			symlinkSync(sharedExtensionsDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedSkillsDir, join(agentDir, "skills"), "dir");
			symlinkSync(sharedPromptsDir, join(agentDir, "prompts"), "dir");
			symlinkSync(sharedThemesDir, join(agentDir, "themes"), "dir");
			symlinkSync(sharedExtensionsDir, join(tempDir, ".pi", "extensions"), "dir");
			symlinkSync(sharedSkillsDir, join(tempDir, ".pi", "skills"), "dir");
			symlinkSync(sharedPromptsDir, join(tempDir, ".pi", "prompts"), "dir");
			symlinkSync(sharedThemesDir, join(tempDir, ".pi", "themes"), "dir");

			const result = await packageManager.resolve();

			expect({
				extensions: result.extensions.length,
				skills: result.skills.length,
				prompts: result.prompts.length,
				themes: result.themes.length,
			}).toEqual({
				extensions: 1,
				skills: 1,
				prompts: 1,
				themes: 1,
			});

			// Project auto-discovered has higher precedence than user auto-discovered,
			// so the surviving entry should be scoped to project.
			expect(result.extensions[0].metadata.scope).toBe("project");
			expect(result.skills[0].metadata.scope).toBe("project");
			expect(result.prompts[0].metadata.scope).toBe("project");
			expect(result.themes[0].metadata.scope).toBe("project");
		});

		it("should auto-discover project prompts with overrides", async () => {
			const promptsDir = join(tempDir, ".pi", "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "is.md");
			writeFileSync(promptPath, "Is prompt");

			settingsManager.setProjectPromptTemplatePaths(["!prompts/is.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve directory with package.json pi.extensions in extensions setting", async () => {
			// Create a package with pi.extensions in package.json
			const pkgDir = join(tempDir, "my-extensions-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-extensions-pkg",
					pi: {
						extensions: ["./extensions/clip.ts", "./extensions/cost.ts"],
					},
				}),
			);
			writeFileSync(join(pkgDir, "extensions", "clip.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "cost.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "helper.ts"), "export const x = 1;"); // Not in manifest, shouldn't be loaded

			// Add the directory to extensions setting (not packages setting)
			settingsManager.setExtensionPaths([pkgDir]);

			const result = await packageManager.resolve();

			// Should find the extensions declared in package.json pi.extensions
			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "clip.ts") && r.enabled)).toBe(
				true,
			);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "cost.ts") && r.enabled)).toBe(
				true,
			);

			// Should NOT find helper.ts (not declared in manifest)
			expect(result.extensions.some((r) => pathEndsWith(r.path, "helper.ts"))).toBe(false);
		});
	});

	describe(".agents/skills auto-discovery", () => {
		it("should scan .agents/skills from cwd up to git repo root", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const aboveRepoSkill = join(tempDir, ".agents", "skills", "above-repo", "SKILL.md");
			mkdirSync(join(tempDir, ".agents", "skills", "above-repo"), { recursive: true });
			writeFileSync(aboveRepoSkill, "---\nname: above-repo\ndescription: above\n---\n");

			const repoRootSkill = join(repoRoot, ".agents", "skills", "repo-root", "SKILL.md");
			mkdirSync(join(repoRoot, ".agents", "skills", "repo-root"), { recursive: true });
			writeFileSync(repoRootSkill, "---\nname: repo-root\ndescription: repo\n---\n");

			const nestedSkill = join(repoRoot, "packages", ".agents", "skills", "nested", "SKILL.md");
			mkdirSync(join(repoRoot, "packages", ".agents", "skills", "nested"), { recursive: true });
			writeFileSync(nestedSkill, "---\nname: nested\ndescription: nested\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === repoRootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === aboveRepoSkill)).toBe(false);
		});

		it("should scan .agents/skills up to filesystem root when not in a git repo", async () => {
			const nonRepoRoot = join(tempDir, "non-repo");
			const nestedCwd = join(nonRepoRoot, "a", "b");
			mkdirSync(nestedCwd, { recursive: true });

			const rootSkill = join(nonRepoRoot, ".agents", "skills", "root", "SKILL.md");
			mkdirSync(join(nonRepoRoot, ".agents", "skills", "root"), { recursive: true });
			writeFileSync(rootSkill, "---\nname: root\ndescription: root\n---\n");

			const middleSkill = join(nonRepoRoot, "a", ".agents", "skills", "middle", "SKILL.md");
			mkdirSync(join(nonRepoRoot, "a", ".agents", "skills", "middle"), { recursive: true });
			writeFileSync(middleSkill, "---\nname: middle\ndescription: middle\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === middleSkill && r.enabled)).toBe(true);
		});

		it("should ignore root markdown files in .agents/skills", async () => {
			const agentsSkillsDir = join(tempDir, ".agents", "skills");
			mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
			const rootSkill = join(agentsSkillsDir, "root-file.md");
			const nestedSkill = join(agentsSkillsDir, "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const pm = new DefaultPackageManager({
				cwd: join(tempDir, "work"),
				agentDir,
				settingsManager,
			});
			mkdirSync(join(tempDir, "work"), { recursive: true });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
		});

		it("should keep ~/.agents/skills user-scoped when cwd is under home in a non-git directory", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const cwd = join(tempDir, "scratch", "nested");
				const localAgentDir = join(tempDir, ".pi", "agent");
				const localSettingsManager = SettingsManager.inMemory();
				mkdirSync(cwd, { recursive: true });
				mkdirSync(localAgentDir, { recursive: true });

				const homeSkill = join(tempDir, ".agents", "skills", "home-skill", "SKILL.md");
				mkdirSync(join(tempDir, ".agents", "skills", "home-skill"), { recursive: true });
				writeFileSync(homeSkill, "---\nname: home-skill\ndescription: home\n---\n");

				const pm = new DefaultPackageManager({
					cwd,
					agentDir: localAgentDir,
					settingsManager: localSettingsManager,
				});

				const result = await pm.resolve();
				const matchingSkills = result.skills.filter((r) => r.path === homeSkill);
				expect(matchingSkills).toHaveLength(1);
				expect(matchingSkills[0]?.enabled).toBe(true);
				expect(matchingSkills[0]?.metadata.scope).toBe("user");
				expect(matchingSkills[0]?.metadata.source).toBe("auto");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should dedupe user skill entries when ~/.pi/agent/skills is a symlink to ~/.agents/skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentSkillsDir = join(agentDir, "skills");
				const agentsSkillsDir = join(tempDir, ".agents", "skills");
				mkdirSync(agentsSkillsDir, { recursive: true });
				// Use junction on Windows to avoid EPERM when symlink privileges are unavailable.
				const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
				symlinkSync(agentsSkillsDir, agentSkillsDir, directoryLinkType);

				const skillPath = join(agentsSkillsDir, "foo", "SKILL.md");
				mkdirSync(join(agentsSkillsDir, "foo"), { recursive: true });
				writeFileSync(skillPath, "---\nname: foo\ndescription: foo\n---\n");

				const result = await packageManager.resolve();
				const fooSkills = result.skills.filter((r) => pathEndsWith(r.path, "foo/SKILL.md"));

				expect(fooSkills).toHaveLength(1);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe("ignore files", () => {
		it("should respect .gitignore in skill directories", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n__pycache__\n");

			const goodSkillDir = join(skillsDir, "good-skill");
			mkdirSync(goodSkillDir, { recursive: true });
			writeFileSync(join(goodSkillDir, "SKILL.md"), "---\nname: good-skill\ndescription: Good\n---\nContent");

			const ignoredSkillDir = join(skillsDir, "venv", "bad-skill");
			mkdirSync(ignoredSkillDir, { recursive: true });
			writeFileSync(join(ignoredSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path.includes("good-skill") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path.includes("venv") && r.enabled)).toBe(false);
		});

		it("should not apply parent .gitignore to .pi auto-discovery", async () => {
			writeFileSync(join(tempDir, ".gitignore"), ".pi\n");

			const skillDir = join(tempDir, ".pi", "skills", "auto-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillPath = join(skillDir, "SKILL.md");
			writeFileSync(skillPath, "---\nname: auto-skill\ndescription: Auto\n---\nContent");

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillPath && r.enabled)).toBe(true);
		});
	});

	describe("resolveExtensionSources", () => {
		it("should resolve local paths", async () => {
			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			const result = await packageManager.resolveExtensionSources([extPath]);
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should handle directories with pi manifest", async () => {
			const pkgDir = join(tempDir, "my-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-package",
					pi: {
						extensions: ["./src/index.ts"],
						skills: ["./skills"],
					},
				}),
			);
			mkdirSync(join(pkgDir, "src"), { recursive: true });
			writeFileSync(join(pkgDir, "src", "index.ts"), "export default function() {}");
			mkdirSync(join(pkgDir, "skills", "my-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "my-skill", "SKILL.md"),
				"---\nname: my-skill\ndescription: Test\n---\nContent",
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "src", "index.ts") && r.enabled)).toBe(true);
			// Skills with SKILL.md are returned as file paths
			expect(result.skills.some((r) => r.path === join(pkgDir, "skills", "my-skill", "SKILL.md") && r.enabled)).toBe(
				true,
			);
		});

		it("should handle directories with auto-discovery layout", async () => {
			const pkgDir = join(tempDir, "auto-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "main.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "themes", "dark.json"), "{}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "main.ts") && r.enabled)).toBe(true);
			expect(result.themes.some((r) => pathEndsWith(r.path, "dark.json") && r.enabled)).toBe(true);
		});

		it("should stop recursing when a package skill directory contains SKILL.md", async () => {
			const pkgDir = join(tempDir, "skill-root-pkg");
			mkdirSync(join(pkgDir, "skills", "root-skill", "nested-skill"), { recursive: true });
			const rootSkill = join(pkgDir, "skills", "root-skill", "SKILL.md");
			const nestedSkill = join(pkgDir, "skills", "root-skill", "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-skill\ndescription: Root skill\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill)).toBe(false);
		});
	});

	describe("progress callback", () => {
		it("should emit progress events", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			// Local paths don't trigger install progress, but we can verify the callback is set
			await packageManager.resolveExtensionSources([extPath]);

			// For now just verify no errors - npm/git would trigger actual events
			expect(events.length).toBe(0);
		});
	});

	describe("windows command spawning", () => {
		it("should avoid the shell for git so Windows paths with spaces stay single arguments", () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			const managerWithInternals = packageManager as unknown as {
				shouldUseWindowsShell(command: string): boolean;
			};

			expect(managerWithInternals.shouldUseWindowsShell("git")).toBe(false);
			expect(managerWithInternals.shouldUseWindowsShell("npm")).toBe(true);
			expect(managerWithInternals.shouldUseWindowsShell("pnpm")).toBe(true);
			expect(managerWithInternals.shouldUseWindowsShell("C:/Program Files/nodejs/npm.cmd")).toBe(true);
		});
	});

	describe("npmCommand", () => {
		it("should use npmCommand argv for npm installs", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.install("npm:@scope/pkg");

			expect(runCommandSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "install", "-g", "@scope/pkg"],
				undefined,
			);
		});

		it("should install git package dependencies with --omit=dev", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command === "git" && args[0] === "clone") {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					}
				});

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev"], { cwd: targetDir });
		});

		it("should use plain install for git package dependencies when npmCommand is configured", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command === "git" && args[0] === "clone") {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					}
				});

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith("pnpm", ["install"], { cwd: targetDir });
		});

		it("should update git package dependencies with --omit=dev", async () => {
			const source = "git:github.com/user/repo";
			const targetDir = join(tempDir, ".pi", "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
			settingsManager.setProjectPackages([source]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockImplementation(async (...callArgs: unknown[]) => {
				const [_command, args] = callArgs as [string, string[]];
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") {
					return "origin/main";
				}
				if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			expect(runCommandSpy).toHaveBeenCalledWith("npm", ["install", "--omit=dev"], { cwd: targetDir });
		});

		it("should use plain install through npmCommand argv when updating git package dependencies", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "pnpm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const source = "git:github.com/user/repo";
			const targetDir = join(tempDir, ".pi", "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
			settingsManager.setProjectPackages([source]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockImplementation(async (...callArgs: unknown[]) => {
				const [_command, args] = callArgs as [string, string[]];
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") {
					return "origin/main";
				}
				if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
					return "remote-head";
				}
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			expect(runCommandSpy).toHaveBeenCalledWith("mise", ["exec", "node@20", "--", "pnpm", "install"], {
				cwd: targetDir,
			});
		});

		it("should use npmCommand argv for npm root lookup and invalidate cached root when npmCommand changes", () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const root20 = join(tempDir, "node20", "lib", "node_modules");
			const root22 = join(tempDir, "node22", "lib", "node_modules");
			mkdirSync(join(root20, "@scope", "pkg"), { recursive: true });

			const runCommandSyncSpy = vi
				.spyOn(packageManager as any, "runCommandSync")
				.mockImplementation((...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "mise") {
						throw new Error(`unexpected command ${command}`);
					}
					if (args[1] === "node@20") {
						return root20;
					}
					if (args[1] === "node@22") {
						return root22;
					}
					throw new Error(`unexpected args ${args.join(" ")}`);
				});

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBe(join(root20, "@scope", "pkg"));
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(1, "mise", ["exec", "node@20", "--", "npm", "root", "-g"]);

			settingsManager.setNpmCommand(["mise", "exec", "node@22", "--", "npm"]);

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBeUndefined();
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(2, "mise", ["exec", "node@22", "--", "npm", "root", "-g"]);
		});
	});

	describe("source parsing", () => {
		it("should emit progress events on install attempt", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			// Use public install method which emits progress events
			try {
				await packageManager.install("npm:nonexistent-package@1.0.0");
			} catch {
				// Expected to fail - package doesn't exist
			}

			// Should have emitted start event before failure
			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
			// Should have emitted error event
			expect(events.some((e) => e.type === "error")).toBe(true);
		});

		it("should recognize github URLs without git: prefix", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));
			const previousGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
			process.env.GIT_TERMINAL_PROMPT = "0";

			try {
				// This should be parsed as a git source, not throw "unsupported"
				try {
					await packageManager.install("https://github.com/nonexistent/repo");
				} catch {
					// Expected to fail - repo doesn't exist
				}
			} finally {
				if (previousGitTerminalPrompt === undefined) {
					delete process.env.GIT_TERMINAL_PROMPT;
				} else {
					process.env.GIT_TERMINAL_PROMPT = previousGitTerminalPrompt;
				}
			}

			// Should have attempted clone, not thrown unsupported error
			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
		});

		it("should parse package source types from docs examples", () => {
			expect((packageManager as any).parseSource("npm:@scope/pkg@1.2.3").type).toBe("npm");
			expect((packageManager as any).parseSource("npm:pkg").type).toBe("npm");

			expect((packageManager as any).parseSource("git:github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("https://github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("git:git@github.com:user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("ssh://git@github.com/user/repo@v1").type).toBe("git");

			expect((packageManager as any).parseSource("/absolute/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("./relative/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("../relative/path/to/package").type).toBe("local");
		});

		it("should never parse dot-relative paths as git", () => {
			const dotSlash = (packageManager as any).parseSource("./packages/agent-timers");
			expect(dotSlash.type).toBe("local");
			expect(dotSlash.path).toBe("./packages/agent-timers");

			const dotDotSlash = (packageManager as any).parseSource("../packages/agent-timers");
			expect(dotDotSlash.type).toBe("local");
			expect(dotDotSlash.path).toBe("../packages/agent-timers");
		});
	});

	describe("settings source normalization", () => {
		it("should store global local packages relative to agent settings base", () => {
			const pkgDir = join(tempDir, "packages", "local-global-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./packages/local-global-pkg");
			expect(added).toBe(true);

			const settings = settingsManager.getGlobalSettings();
			const rel = relative(agentDir, pkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should store project local packages relative to .pi settings base", () => {
			const projectPkgDir = join(tempDir, "project-local-pkg");
			mkdirSync(join(projectPkgDir, "extensions"), { recursive: true });
			writeFileSync(join(projectPkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./project-local-pkg", { local: true });
			expect(added).toBe(true);

			const settings = settingsManager.getProjectSettings();
			const rel = relative(join(tempDir, ".pi"), projectPkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should remove local package entries using equivalent path forms", () => {
			const pkgDir = join(tempDir, "remove-local-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			packageManager.addSourceToSettings("./remove-local-pkg");
			const removed = packageManager.removeSourceFromSettings(`${pkgDir}/`);
			expect(removed).toBe(true);
			expect(settingsManager.getGlobalSettings().packages ?? []).toHaveLength(0);
		});
	});

	describe("HTTPS git URL parsing (old behavior)", () => {
		it("should parse HTTPS GitHub URLs correctly", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.pinned).toBe(false);
		});

		it("should parse HTTPS URLs with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse HTTPS URLs with ref", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@v1.2.3");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.ref).toBe("v1.2.3");
			expect(parsed.pinned).toBe(true);
		});

		it("should parse host/path shorthand only with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should treat host/path shorthand as local without git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("github.com/user/repo");
			expect(parsed.type).toBe("local");
		});

		it("should parse HTTPS URLs with .git suffix", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo.git");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse GitLab HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://gitlab.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("gitlab.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Bitbucket HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://bitbucket.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("bitbucket.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Codeberg HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://codeberg.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("codeberg.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should generate correct package identity for protocol and git:-prefixed URLs", async () => {
			const identity1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const identity2 = (packageManager as any).getPackageIdentity("https://github.com/user/repo@v1.0.0");
			const identity3 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const identity4 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			// All should have the same identity (normalized)
			expect(identity1).toBe("git:github.com/user/repo");
			expect(identity2).toBe("git:github.com/user/repo");
			expect(identity3).toBe("git:github.com/user/repo");
			expect(identity4).toBe("git:github.com/user/repo");
		});

		it("should deduplicate git URLs with different supported formats", async () => {
			const pkgDir = join(tempDir, "https-dedup-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "test.ts"), "export default function() {}");

			// Mock the package as if it were cloned from different URL formats
			// In reality, these would all point to the same local dir after install
			settingsManager.setPackages([
				"https://github.com/user/repo",
				"git:github.com/user/repo",
				"https://github.com/user/repo.git",
			]);

			// Since these URLs don't actually exist and we can't clone them,
			// we verify they produce the same identity
			const id1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const id2 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const id3 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			expect(id1).toBe(id2);
			expect(id2).toBe(id3);
		});

		it("should handle HTTPS URLs with refs in resolve", async () => {
			// This tests that the ref is properly extracted and stored
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@main");
			expect(parsed.ref).toBe("main");
			expect(parsed.pinned).toBe(true);

			const parsed2 = (packageManager as any).parseSource("https://github.com/user/repo@feature/branch");
			expect(parsed2.ref).toBe("feature/branch");
		});
	});

	describe("pattern filtering in top-level arrays", () => {
		it("should exclude extensions with ! pattern", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "keep.ts"), "export default function() {}");
			writeFileSync(join(extDir, "remove.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "!**/remove.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "keep.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "remove.ts"))).toBe(true);
		});

		it("should filter themes with glob patterns", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "dark.json"), "{}");
			writeFileSync(join(themesDir, "light.json"), "{}");
			writeFileSync(join(themesDir, "funky.json"), "{}");

			settingsManager.setThemePaths(["themes", "!funky.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "dark.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "light.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "funky.json"))).toBe(true);
		});

		it("should filter prompts with exclusion pattern", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review code");
			writeFileSync(join(promptsDir, "explain.md"), "Explain code");

			settingsManager.setPromptTemplatePaths(["prompts", "!explain.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => isEnabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
		});

		it("should filter skills with exclusion pattern", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(join(skillsDir, "good-skill"), { recursive: true });
			mkdirSync(join(skillsDir, "bad-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(
				join(skillsDir, "bad-skill", "SKILL.md"),
				"---\nname: bad-skill\ndescription: Bad\n---\nContent",
			);

			settingsManager.setSkillPaths(["skills", "!**/bad-skill"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => isDisabled(r, "bad-skill", "includes"))).toBe(true);
		});

		it("should work without patterns (backward compatible)", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setExtensionPaths(["extensions/my-ext.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});
	});

	describe("pattern filtering in pi manifest", () => {
		it("should support glob patterns in manifest extensions", async () => {
			const pkgDir = join(tempDir, "manifest-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "node_modules/dep/extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "local.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "node_modules/dep/extensions", "remote.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "node_modules/dep/extensions", "skip.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "manifest-pkg",
					pi: {
						extensions: ["extensions", "node_modules/dep/extensions", "!**/skip.ts"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => isEnabled(r, "local.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "remote.ts"))).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "skip.ts"))).toBe(false);
		});

		it("should support glob patterns in manifest skills", async () => {
			const pkgDir = join(tempDir, "skill-manifest-pkg");
			mkdirSync(join(pkgDir, "skills/good-skill"), { recursive: true });
			mkdirSync(join(pkgDir, "skills/bad-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills/good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "skills/bad-skill", "SKILL.md"),
				"---\nname: bad-skill\ndescription: Bad\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "skill-manifest-pkg",
					pi: {
						skills: ["skills", "!**/bad-skill"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => r.path.includes("bad-skill"))).toBe(false);
		});

		it("should expand positive glob manifest entries before collecting skills", async () => {
			const pkgDir = join(tempDir, "skill-manifest-glob-pkg");
			mkdirSync(join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown"), { recursive: true });
			mkdirSync(join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown", "SKILL.md"),
				"---\nname: pdf-to-markdown\ndescription: PDF to Markdown\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api", "SKILL.md"),
				"---\nname: document-processor-api\ndescription: DWS\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "skill-manifest-glob-pkg",
					pi: {
						skills: ["./plugins/*/skills"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => isEnabled(r, "pdf-to-markdown", "includes"))).toBe(true);
			expect(result.skills.some((r) => isEnabled(r, "document-processor-api", "includes"))).toBe(true);
		});
	});

	describe("pattern filtering in package filters", () => {
		it("should apply user filters on top of manifest filters (not replace)", async () => {
			// Manifest excludes baz.ts, user excludes bar.ts
			// Result should exclude BOTH
			const pkgDir = join(tempDir, "layered-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "foo.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "bar.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "baz.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "layered-pkg",
					pi: {
						extensions: ["extensions", "!**/baz.ts"],
					},
				}),
			);

			// User filter adds exclusion for bar.ts
			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/bar.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			// foo.ts should be included (not excluded by anyone)
			expect(result.extensions.some((r) => isEnabled(r, "foo.ts"))).toBe(true);
			// bar.ts should be excluded (by user)
			expect(result.extensions.some((r) => isDisabled(r, "bar.ts"))).toBe(true);
			// baz.ts should be excluded (by manifest)
			expect(result.extensions.some((r) => pathEndsWith(r.path, "baz.ts"))).toBe(false);
		});

		it("should exclude extensions from package with ! pattern", async () => {
			const pkgDir = join(tempDir, "pattern-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "foo.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "bar.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "baz.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/baz.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "foo.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "bar.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "baz.ts"))).toBe(true);
		});

		it("should filter themes from package", async () => {
			const pkgDir = join(tempDir, "theme-pkg");
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "themes", "nice.json"), "{}");
			writeFileSync(join(pkgDir, "themes", "ugly.json"), "{}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: [],
					skills: [],
					prompts: [],
					themes: ["!ugly.json"],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "nice.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "ugly.json"))).toBe(true);
		});

		it("should combine include and exclude patterns", async () => {
			const pkgDir = join(tempDir, "combo-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "alpha.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "beta.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "gamma.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["**/alpha.ts", "**/beta.ts", "!**/beta.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "beta.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "gamma.ts"))).toBe(true);
		});

		it("should work with direct paths (no patterns)", async () => {
			const pkgDir = join(tempDir, "direct-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "one.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "two.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["extensions/one.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "one.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "two.ts"))).toBe(true);
		});
	});

	describe("force-include patterns", () => {
		it("should force-include extensions with + pattern after exclusion", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "keep.ts"), "export default function() {}");
			writeFileSync(join(extDir, "excluded.ts"), "export default function() {}");
			writeFileSync(join(extDir, "force-back.ts"), "export default function() {}");

			// Exclude all, then force-include one back
			settingsManager.setExtensionPaths(["extensions", "!extensions/*.ts", "+extensions/force-back.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "keep.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "excluded.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "force-back.ts"))).toBe(true);
		});

		it("should force-include overrides exclude in package filters", async () => {
			const pkgDir = join(tempDir, "force-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "alpha.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "beta.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "gamma.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/*.ts", "+extensions/beta.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "beta.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "gamma.ts"))).toBe(true);
		});

		it("should force-include multiple resources", async () => {
			const pkgDir = join(tempDir, "multi-force-pkg");
			mkdirSync(join(pkgDir, "skills/skill-a"), { recursive: true });
			mkdirSync(join(pkgDir, "skills/skill-b"), { recursive: true });
			mkdirSync(join(pkgDir, "skills/skill-c"), { recursive: true });
			writeFileSync(join(pkgDir, "skills/skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\nContent");
			writeFileSync(join(pkgDir, "skills/skill-b", "SKILL.md"), "---\nname: skill-b\ndescription: B\n---\nContent");
			writeFileSync(join(pkgDir, "skills/skill-c", "SKILL.md"), "---\nname: skill-c\ndescription: C\n---\nContent");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: [],
					skills: ["!**/*", "+skills/skill-a", "+skills/skill-c"],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => isEnabled(r, "skill-a", "includes"))).toBe(true);
			expect(result.skills.some((r) => isDisabled(r, "skill-b", "includes"))).toBe(true);
			expect(result.skills.some((r) => isEnabled(r, "skill-c", "includes"))).toBe(true);
		});

		it("should force-include after specific exclusion", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "a.ts"), "export default function() {}");
			writeFileSync(join(extDir, "b.ts"), "export default function() {}");

			// Specifically exclude b.ts, then force it back
			settingsManager.setExtensionPaths(["extensions", "!extensions/b.ts", "+extensions/b.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "a.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "b.ts"))).toBe(true);
		});

		it("should handle force-include in manifest patterns", async () => {
			const pkgDir = join(tempDir, "manifest-force-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "one.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "two.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "three.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "manifest-force-pkg",
					pi: {
						extensions: ["extensions", "!**/two.ts", "+extensions/two.ts"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => isEnabled(r, "one.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "two.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "three.ts"))).toBe(true);
		});

		it("should force-include themes", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "dark.json"), "{}");
			writeFileSync(join(themesDir, "light.json"), "{}");
			writeFileSync(join(themesDir, "special.json"), "{}");

			settingsManager.setThemePaths(["themes", "!themes/*.json", "+themes/special.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isDisabled(r, "dark.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "light.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "special.json"))).toBe(true);
		});

		it("should force-include prompts", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review");
			writeFileSync(join(promptsDir, "explain.md"), "Explain");
			writeFileSync(join(promptsDir, "debug.md"), "Debug");

			settingsManager.setPromptTemplatePaths(["prompts", "!prompts/*.md", "+prompts/debug.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => isDisabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
			expect(result.prompts.some((r) => isEnabled(r, "debug.md"))).toBe(true);
		});
	});

	describe("force-exclude patterns", () => {
		it("should force-exclude top-level resources", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "alpha.ts"), "export default function() {}");
			writeFileSync(join(extDir, "beta.ts"), "export default function() {}");

			settingsManager.setExtensionPaths(["extensions", "+extensions/alpha.ts", "-extensions/alpha.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "beta.ts"))).toBe(true);
		});

		it("should force-exclude in package filters", async () => {
			const pkgDir = join(tempDir, "force-exclude-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "alpha.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "beta.ts"), "export default function() {}");

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["extensions/*.ts", "+extensions/alpha.ts", "-extensions/alpha.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isDisabled(r, "alpha.ts"))).toBe(true);
			expect(result.extensions.some((r) => isEnabled(r, "beta.ts"))).toBe(true);
		});
	});

	describe("package deduplication", () => {
		it("should dedupe same local package in global and project (project wins)", async () => {
			const pkgDir = join(tempDir, "shared-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "shared.ts"), "export default function() {}");

			// Same package in both global and project
			settingsManager.setPackages([pkgDir]); // global
			settingsManager.setProjectPackages([pkgDir]); // project

			// Debug: verify settings are stored correctly
			const globalSettings = settingsManager.getGlobalSettings();
			const projectSettings = settingsManager.getProjectSettings();
			expect(globalSettings.packages).toEqual([pkgDir]);
			expect(projectSettings.packages).toEqual([pkgDir]);

			const result = await packageManager.resolve();
			// Should only appear once (deduped), with project scope
			const sharedPaths = result.extensions.filter((r) => r.path.includes("shared-pkg"));
			expect(sharedPaths.length).toBe(1);
			expect(sharedPaths[0].metadata.scope).toBe("project");
		});

		it("should keep both if different packages", async () => {
			const pkg1Dir = join(tempDir, "pkg1");
			const pkg2Dir = join(tempDir, "pkg2");
			mkdirSync(join(pkg1Dir, "extensions"), { recursive: true });
			mkdirSync(join(pkg2Dir, "extensions"), { recursive: true });
			writeFileSync(join(pkg1Dir, "extensions", "from-pkg1.ts"), "export default function() {}");
			writeFileSync(join(pkg2Dir, "extensions", "from-pkg2.ts"), "export default function() {}");

			settingsManager.setPackages([pkg1Dir]); // global
			settingsManager.setProjectPackages([pkg2Dir]); // project

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path.includes("pkg1"))).toBe(true);
			expect(result.extensions.some((r) => r.path.includes("pkg2"))).toBe(true);
		});

		it("should dedupe SSH and HTTPS URLs for same repo", async () => {
			// Same repository, different URL formats
			const httpsUrl = "https://github.com/user/repo";
			const sshUrl = "git:git@github.com:user/repo";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			// Both should resolve to the same identity
			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH and HTTPS with refs", async () => {
			const httpsUrl = "https://github.com/user/repo@v1.0.0";
			const sshUrl = "git:git@github.com:user/repo@v1.0.0";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			// Identity should ignore ref (version)
			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH URL with ssh:// protocol and git@ format", async () => {
			const sshProtocol = "ssh://git@github.com/user/repo";
			const gitAt = "git:git@github.com:user/repo";

			const sshProtocolIdentity = (packageManager as any).getPackageIdentity(sshProtocol);
			const gitAtIdentity = (packageManager as any).getPackageIdentity(gitAt);

			// Both SSH formats should resolve to same identity
			expect(sshProtocolIdentity).toBe("git:github.com/user/repo");
			expect(gitAtIdentity).toBe("git:github.com/user/repo");
			expect(sshProtocolIdentity).toBe(gitAtIdentity);
		});

		it("should dedupe all supported URL formats for same repo", async () => {
			const urls = [
				"https://github.com/user/repo",
				"https://github.com/user/repo.git",
				"ssh://git@github.com/user/repo",
				"git:https://github.com/user/repo",
				"git:github.com/user/repo",
				"git:git@github.com:user/repo",
				"git:git@github.com:user/repo.git",
			];

			const identities = urls.map((url) => (packageManager as any).getPackageIdentity(url));

			// All should produce the same identity
			const uniqueIdentities = [...new Set(identities)];
			expect(uniqueIdentities.length).toBe(1);
			expect(uniqueIdentities[0]).toBe("git:github.com/user/repo");
		});

		it("should keep different repos separate (HTTPS vs SSH)", async () => {
			const repo1Https = "https://github.com/user/repo1";
			const repo2Ssh = "git:git@github.com:user/repo2";

			const id1 = (packageManager as any).getPackageIdentity(repo1Https);
			const id2 = (packageManager as any).getPackageIdentity(repo2Ssh);

			// Different repos should have different identities
			expect(id1).toBe("git:github.com/user/repo1");
			expect(id2).toBe("git:github.com/user/repo2");
			expect(id1).not.toBe(id2);
		});
	});

	describe("multi-file extension discovery (issue #1102)", () => {
		it("should only load index.ts from subdirectories, not helper modules", async () => {
			// Regression test: packages with multi-file extensions in subdirectories
			// should only load the index.ts entry point, not helper modules like agents.ts
			const pkgDir = join(tempDir, "multifile-pkg");
			mkdirSync(join(pkgDir, "extensions", "subagent"), { recursive: true });

			// Main entry point
			writeFileSync(
				join(pkgDir, "extensions", "subagent", "index.ts"),
				`import { helper } from "./agents.js";
export default function(api) { api.registerTool({ name: "test", description: "test", execute: async () => helper() }); }`,
			);
			// Helper module (should NOT be loaded as standalone extension)
			writeFileSync(
				join(pkgDir, "extensions", "subagent", "agents.ts"),
				`export function helper() { return "helper"; }`,
			);
			// Top-level extension file (should be loaded)
			writeFileSync(join(pkgDir, "extensions", "standalone.ts"), "export default function(api) {}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			// Should find the index.ts and standalone.ts
			expect(result.extensions.some((r) => pathEndsWith(r.path, "subagent/index.ts") && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "standalone.ts") && r.enabled)).toBe(true);

			// Should NOT find agents.ts as a standalone extension
			expect(result.extensions.some((r) => pathEndsWith(r.path, "agents.ts"))).toBe(false);
		});

		it("should respect package.json pi.extensions manifest in subdirectories", async () => {
			const pkgDir = join(tempDir, "manifest-subdir-pkg");
			mkdirSync(join(pkgDir, "extensions", "custom"), { recursive: true });

			// Subdirectory with its own manifest
			writeFileSync(
				join(pkgDir, "extensions", "custom", "package.json"),
				JSON.stringify({
					pi: {
						extensions: ["./main.ts"],
					},
				}),
			);
			writeFileSync(join(pkgDir, "extensions", "custom", "main.ts"), "export default function(api) {}");
			writeFileSync(join(pkgDir, "extensions", "custom", "utils.ts"), "export const util = 1;");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			// Should find main.ts declared in manifest
			expect(result.extensions.some((r) => pathEndsWith(r.path, "custom/main.ts") && r.enabled)).toBe(true);

			// Should NOT find utils.ts (not declared in manifest)
			expect(result.extensions.some((r) => pathEndsWith(r.path, "utils.ts"))).toBe(false);
		});

		it("should handle mixed top-level files and subdirectories", async () => {
			const pkgDir = join(tempDir, "mixed-pkg");
			mkdirSync(join(pkgDir, "extensions", "complex"), { recursive: true });

			// Top-level extension
			writeFileSync(join(pkgDir, "extensions", "simple.ts"), "export default function(api) {}");

			// Subdirectory with index.ts + helpers
			writeFileSync(
				join(pkgDir, "extensions", "complex", "index.ts"),
				"import { a } from './a.js'; export default function(api) {}",
			);
			writeFileSync(join(pkgDir, "extensions", "complex", "a.ts"), "export const a = 1;");
			writeFileSync(join(pkgDir, "extensions", "complex", "b.ts"), "export const b = 2;");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			// Should find simple.ts and complex/index.ts
			expect(result.extensions.some((r) => pathEndsWith(r.path, "simple.ts") && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/index.ts") && r.enabled)).toBe(true);

			// Should NOT find helper modules
			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/a.ts"))).toBe(false);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/b.ts"))).toBe(false);

			// Total should be exactly 2
			expect(result.extensions.filter((r) => r.enabled).length).toBe(2);
		});

		it("should skip subdirectories without index.ts or manifest", async () => {
			const pkgDir = join(tempDir, "no-entry-pkg");
			mkdirSync(join(pkgDir, "extensions", "broken"), { recursive: true });

			// Subdirectory with no index.ts and no manifest
			writeFileSync(join(pkgDir, "extensions", "broken", "helper.ts"), "export const x = 1;");
			writeFileSync(join(pkgDir, "extensions", "broken", "another.ts"), "export const y = 2;");

			// Valid top-level extension
			writeFileSync(join(pkgDir, "extensions", "valid.ts"), "export default function(api) {}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			// Should only find the valid top-level extension
			expect(result.extensions.some((r) => pathEndsWith(r.path, "valid.ts") && r.enabled)).toBe(true);
			expect(result.extensions.filter((r) => r.enabled).length).toBe(1);
		});
	});

	describe("offline mode and network timeouts", () => {
		it("should update project npm packages using @latest when newer version is available", async () => {
			const installedPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledWith(
				"npm",
				["install", "example@latest", "--prefix", join(tempDir, ".pi", "npm")],
				undefined,
			);
		});

		it("should skip project npm update when installed version matches latest", async () => {
			const installedPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.2.3" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should batch npm updates per scope and run git updates in parallel while skipping pinned and current packages", async () => {
			vi.spyOn(packageManager as any, "getGlobalNpmRoot").mockReturnValue(join(agentDir, "node_modules"));

			const userOldPath = join(agentDir, "node_modules", "user-old");
			const userCurrentPath = join(agentDir, "node_modules", "user-current");
			const userUnknownPath = join(agentDir, "node_modules", "user-unknown");
			const projectOldPath = join(tempDir, ".pi", "npm", "node_modules", "project-old");
			const projectCurrentPath = join(tempDir, ".pi", "npm", "node_modules", "project-current");
			const installPaths = [userOldPath, userCurrentPath, userUnknownPath, projectOldPath, projectCurrentPath];
			for (const installPath of installPaths) {
				mkdirSync(installPath, { recursive: true });
			}
			writeFileSync(join(userOldPath, "package.json"), JSON.stringify({ name: "user-old", version: "1.0.0" }));
			writeFileSync(
				join(userCurrentPath, "package.json"),
				JSON.stringify({ name: "user-current", version: "1.0.0" }),
			);
			writeFileSync(
				join(userUnknownPath, "package.json"),
				JSON.stringify({ name: "user-unknown", version: "1.0.0" }),
			);
			writeFileSync(join(projectOldPath, "package.json"), JSON.stringify({ name: "project-old", version: "1.0.0" }));
			writeFileSync(
				join(projectCurrentPath, "package.json"),
				JSON.stringify({ name: "project-current", version: "1.0.0" }),
			);

			settingsManager.setPackages([
				"npm:user-old",
				"npm:user-current",
				"npm:user-unknown",
				"npm:user-pinned@1.0.0",
				"git:github.com/example/user-repo-a",
				"git:github.com/example/user-repo-b",
				"git:github.com/example/user-repo-pinned@v1",
			]);
			settingsManager.setProjectPackages([
				"npm:project-old",
				"npm:project-current",
				"npm:project-missing",
				"git:github.com/example/project-repo-a",
			]);

			const runCommandCaptureSpy = vi
				.spyOn(packageManager as any, "runCommandCapture")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [_command, args] = callArgs as [string, string[]];
					if (args[0] !== "view") {
						throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
					}
					switch (args[1]) {
						case "user-old":
						case "project-old":
							return '"2.0.0"';
						case "user-current":
						case "project-current":
							return '"1.0.0"';
						case "user-unknown":
							throw new Error("registry unavailable");
						default:
							throw new Error(`Unexpected package lookup: ${args[1]}`);
					}
				});

			let activeNpmUpdates = 0;
			let maxConcurrentNpmUpdates = 0;
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "npm") {
						throw new Error(`Unexpected runCommand call: ${command} ${args.join(" ")}`);
					}
					activeNpmUpdates += 1;
					maxConcurrentNpmUpdates = Math.max(maxConcurrentNpmUpdates, activeNpmUpdates);
					await new Promise((resolve) => setTimeout(resolve, 20));
					activeNpmUpdates -= 1;
				});

			let activeGitUpdates = 0;
			let maxConcurrentGitUpdates = 0;
			const updateGitSpy = vi.spyOn(packageManager as any, "updateGit").mockImplementation(async () => {
				activeGitUpdates += 1;
				maxConcurrentGitUpdates = Math.max(maxConcurrentGitUpdates, activeGitUpdates);
				await new Promise((resolve) => setTimeout(resolve, 20));
				activeGitUpdates -= 1;
			});

			await packageManager.update();

			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(5);
			expect(runCommandSpy).toHaveBeenCalledTimes(2);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				1,
				"npm",
				["install", "-g", "user-old@latest", "user-unknown@latest"],
				undefined,
			);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				2,
				"npm",
				["install", "project-old@latest", "project-missing@latest", "--prefix", join(tempDir, ".pi", "npm")],
				undefined,
			);
			expect(updateGitSpy).toHaveBeenCalledTimes(3);
			expect(maxConcurrentNpmUpdates).toBeGreaterThan(1);
			expect(maxConcurrentGitUpdates).toBeGreaterThan(1);
		});

		it("should suggest npm source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["npm:example"]);

			await expect(packageManager.update("example")).rejects.toThrow(
				"No matching package found for example. Did you mean npm:example?",
			);
		});

		it("should suggest git source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["git:github.com/example/repo"]);

			await expect(packageManager.update("github.com/example/repo")).rejects.toThrow(
				"No matching package found for github.com/example/repo. Did you mean git:github.com/example/repo?",
			);
		});

		it("should skip installing missing package sources when offline", async () => {
			process.env.PI_OFFLINE = "1";
			settingsManager.setProjectPackages(["npm:missing-package", "git:github.com/example/missing-repo"]);

			const installParsedSourceSpy = vi.spyOn(packageManager as any, "installParsedSource");

			const result = await packageManager.resolve();
			const allResources = [...result.extensions, ...result.skills, ...result.prompts, ...result.themes];
			expect(allResources.some((r) => r.metadata.origin === "package")).toBe(false);
			expect(installParsedSourceSpy).not.toHaveBeenCalled();
		});

		it("should skip refreshing temporary git sources when offline", async () => {
			process.env.PI_OFFLINE = "1";
			const gitSource = "git:github.com/example/repo";
			const parsedGitSource = (packageManager as any).parseSource(gitSource);
			const installedPath = (packageManager as any).getGitInstallPath(parsedGitSource, "temporary") as string;

			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");

			const refreshTemporaryGitSourceSpy = vi.spyOn(packageManager as any, "refreshTemporaryGitSource");

			const result = await packageManager.resolveExtensionSources([gitSource], { temporary: true });
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(refreshTemporaryGitSourceSpy).not.toHaveBeenCalled();
		});

		it("should not run npm view during resolve for installed unpinned packages", async () => {
			const installedPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		it("should reinstall pinned npm packages when installed version does not match", async () => {
			const installedPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@2.0.0"]);

			const installParsedSourceSpy = vi
				.spyOn(packageManager as any, "installParsedSource")
				.mockResolvedValue(undefined);

			await packageManager.resolve();
			expect(installParsedSourceSpy).toHaveBeenCalledTimes(1);
		});

		it("should not check package updates when offline", async () => {
			process.env.PI_OFFLINE = "1";
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		it("should report updates for installed unpinned npm packages", async () => {
			const installedPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([
				{
					source: "npm:example",
					displayName: "example",
					type: "npm",
					scope: "project",
				},
			]);
		});

		it("should skip pinned packages when checking for updates", async () => {
			const installedNpmPath = join(tempDir, ".pi", "npm", "node_modules", "example");
			mkdirSync(installedNpmPath, { recursive: true });
			writeFileSync(join(installedNpmPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			const parsedGitSource = (packageManager as any).parseSource("git:github.com/example/repo@v1");
			const installedGitPath = (packageManager as any).getGitInstallPath(parsedGitSource, "project") as string;
			mkdirSync(installedGitPath, { recursive: true });

			settingsManager.setProjectPackages(["npm:example@1.0.0", "git:github.com/example/repo@v1"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");
			const gitUpdateSpy = vi.spyOn(packageManager as any, "gitHasAvailableUpdate");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
			expect(gitUpdateSpy).not.toHaveBeenCalled();
		});

		it("should use npm view to fetch latest version", async () => {
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("example");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(1);
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
		});

		it("should use npmCommand argv for npm update checks", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("@scope/pkg");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "view", "@scope/pkg", "version", "--json"],
				expect.objectContaining({ cwd: tempDir }),
			);
		});

		it("should wait for close before resolving captured stdout", async () => {
			const managerWithInternals = packageManager as unknown as {
				spawnCaptureCommand(
					command: string,
					args: string[],
					options?: { cwd?: string; env?: Record<string, string> },
				): MockSpawnedProcess;
				runCommandCapture(
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				): Promise<string>;
			};
			const child = new MockSpawnedProcess();
			vi.spyOn(managerWithInternals, "spawnCaptureCommand").mockReturnValue(child);

			let settled = false;
			const capturePromise = managerWithInternals.runCommandCapture("git", ["rev-parse", "HEAD"]).then((value) => {
				settled = true;
				return value;
			});

			child.emit("exit", 0, null);
			await Promise.resolve();
			expect(settled).toBe(false);

			child.stdout.write("abc123\n");
			child.stdout.end();
			child.emit("close", 0, null);

			await expect(capturePromise).resolves.toBe("abc123");
		});
	});
});
