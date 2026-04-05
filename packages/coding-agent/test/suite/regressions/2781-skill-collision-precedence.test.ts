import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";

describe("issue #2781 skill collision precedence: user skills should override package skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-2781-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPackageWithSkill(name: string, description: string): string {
		const pkgDir = join(tempDir, `fake-package-${name}`);
		const skillDir = join(pkgDir, "skills", name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: `fake-pkg-${name}`, version: "1.0.0", pi: { skills: [`skills/${name}`] } }, null, 2),
		);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\n---\nPackage skill content`,
		);
		return pkgDir;
	}

	function createUserSkill(name: string, description: string): string {
		const skillDir = join(agentDir, "skills", name);
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\nUser skill content`);
		return skillPath;
	}

	function createProjectSkill(name: string, description: string): string {
		const skillDir = join(cwd, ".pi", "skills", name);
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\nProject skill content`);
		return skillPath;
	}

	function createSettingsWithPackage(pkgDir: string, scope: "user" | "project"): void {
		const settingsDir = scope === "user" ? agentDir : join(cwd, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }, null, 2));
	}

	it("user auto-discovered skill should override package skill with same name", async () => {
		const pkgDir = createPackageWithSkill("web-fetch", "Package web-fetch skill");
		const userSkillPath = createUserSkill("web-fetch", "User web-fetch override");
		createSettingsWithPackage(pkgDir, "user");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const webFetch = skills.find((s) => s.name === "web-fetch");
		expect(webFetch).toBeDefined();
		expect(webFetch!.filePath).toBe(userSkillPath);
		expect(webFetch!.description).toBe("User web-fetch override");
	});

	it("project auto-discovered skill should override package skill with same name", async () => {
		const pkgDir = createPackageWithSkill("web-fetch", "Package web-fetch skill");
		const projectSkillPath = createProjectSkill("web-fetch", "Project web-fetch override");
		createSettingsWithPackage(pkgDir, "user");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const webFetch = skills.find((s) => s.name === "web-fetch");
		expect(webFetch).toBeDefined();
		expect(webFetch!.filePath).toBe(projectSkillPath);
		expect(webFetch!.description).toBe("Project web-fetch override");
	});

	it("project skill should override user skill which should override package skill", async () => {
		const pkgDir = createPackageWithSkill("web-fetch", "Package web-fetch skill");
		createUserSkill("web-fetch", "User web-fetch override");
		const projectSkillPath = createProjectSkill("web-fetch", "Project web-fetch override");
		createSettingsWithPackage(pkgDir, "user");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const webFetch = skills.find((s) => s.name === "web-fetch");
		expect(webFetch).toBeDefined();
		expect(webFetch!.filePath).toBe(projectSkillPath);
		expect(webFetch!.description).toBe("Project web-fetch override");
	});

	it("collision diagnostics should report package skill as loser when user skill wins", async () => {
		const pkgDir = createPackageWithSkill("web-fetch", "Package web-fetch skill");
		createUserSkill("web-fetch", "User web-fetch override");
		createSettingsWithPackage(pkgDir, "user");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { diagnostics } = loader.getSkills();
		const collision = diagnostics.find((d) => d.type === "collision" && d.collision?.name === "web-fetch");
		expect(collision).toBeDefined();
		expect(collision!.collision!.loserPath).toContain("fake-package");
	});
});
