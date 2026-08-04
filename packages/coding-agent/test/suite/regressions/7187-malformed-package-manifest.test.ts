import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness } from "../harness.ts";

describe("issue #7187 malformed package manifest", () => {
	it("ignores invalid resource fields without dropping valid fields", async () => {
		const harness = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-7187-"));
		const agentDir = join(tempDir, "agent");
		try {
			const packageDir = join(agentDir, "npm", "node_modules", "bad-package");
			const skillPath = join(packageDir, "skills", "bad", "SKILL.md");
			const promptPath = join(packageDir, "prompts", "valid.md");
			mkdirSync(join(packageDir, "skills", "bad"), { recursive: true });
			mkdirSync(join(packageDir, "prompts"), { recursive: true });
			writeFileSync(skillPath, "---\nname: bad\ndescription: Must not load\n---\n");
			writeFileSync(promptPath, "Valid prompt\n");
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name: "bad-package",
					version: "1.0.0",
					pi: {
						skills: "./skills",
						prompts: ["./prompts"],
					},
				}),
			);
			const packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: ["npm:bad-package"] }),
			});

			const resources = await packageManager.resolve();
			expect(resources.skills.map((skill) => skill.path)).not.toContain(skillPath);
			expect(resources.prompts.map((prompt) => prompt.path)).toContain(promptPath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			harness.cleanup();
		}
	});
});
