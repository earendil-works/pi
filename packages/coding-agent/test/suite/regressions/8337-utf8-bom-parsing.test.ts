import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { parseFrontmatter } from "../../../src/utils/frontmatter.ts";
import { splitBom } from "../../../src/utils/text.ts";

describe("issue #8337 UTF-8 BOM parsing", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-8337-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("loads frontmatter and settings with a leading BOM", async () => {
		expect(splitBom("\uFEFFcontent")).toEqual({ bom: "\uFEFF", text: "content" });
		const document = "---\nname: demo\ndescription: Test\n---\nBody";
		expect(parseFrontmatter(`\uFEFF${document}`)).toEqual({
			frontmatter: { name: "demo", description: "Test" },
			body: "Body",
		});

		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const globalSettingsPath = join(agentDir, "settings.json");
		writeFileSync(globalSettingsPath, `\uFEFF${JSON.stringify({ defaultModel: "global-model" })}`);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			`\uFEFF${JSON.stringify({ defaultProvider: "project-provider" })}`,
		);

		const settings = SettingsManager.create(projectDir, agentDir);
		expect(settings.getDefaultModel()).toBe("global-model");
		expect(settings.getDefaultProvider()).toBe("project-provider");

		settings.setTheme("dark");
		await settings.flush();
		expect(readFileSync(globalSettingsPath, "utf-8")).not.toMatch(/^\uFEFF/);
	});
});
