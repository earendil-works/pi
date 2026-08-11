import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const customDirectory = resolve(__dirname, "../../fixtures/skills/custom-directory");
const readmePath = join(customDirectory, "README.md");

describe("regression #7805: custom skill directories ignore root documentation", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalHome: string | undefined;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-7805-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadWithHarness(loader: DefaultResourceLoader) {
		await loader.reload();
		harnesses.push(await createHarness({ resourceLoader: loader }));
		return loader.getSkills();
	}

	function expectCustomDirectoryLoaded(result: ReturnType<DefaultResourceLoader["getSkills"]>) {
		const names = result.skills
			.filter((skill) => skill.filePath.startsWith(customDirectory))
			.map((skill) => skill.name)
			.sort();
		const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.path?.startsWith(customDirectory));

		expect(names).toEqual(["nested-custom-skill", "root-skill"]);
		expect(diagnostics).toEqual([]);
	}

	it("ignores root documentation in settings directories", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ skills: [customDirectory] }),
		});

		expectCustomDirectoryLoaded(await loadWithHarness(loader));
	});

	it("ignores root documentation in CLI directories", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [customDirectory],
			candidateSkillDirectories: [customDirectory],
		});

		expectCustomDirectoryLoaded(await loadWithHarness(loader));
	});

	it("strictly validates explicitly configured Markdown files", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ skills: [readmePath] }),
		});

		const result = await loadWithHarness(loader);

		expect(result.skills.some((skill) => skill.filePath === readmePath)).toBe(false);
		expect(result.diagnostics).toContainEqual({
			type: "warning",
			message: "description is required",
			path: readmePath,
		});
	});

	it("keeps programmatic skill directories strict by default", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [customDirectory],
		});

		const result = await loadWithHarness(loader);
		const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.path?.startsWith(customDirectory));

		expect(diagnostics.some((diagnostic) => diagnostic.path === readmePath)).toBe(true);
		expect(diagnostics.some((diagnostic) => diagnostic.path?.endsWith("broken-frontmatter.md"))).toBe(true);
	});

	it.skipIf(process.platform === "win32")("reports unreadable files in candidate directories", async () => {
		const candidateDirectory = join(tempDir, "candidate-skills");
		const unreadablePath = join(candidateDirectory, "unreadable.md");
		mkdirSync(candidateDirectory);
		writeFileSync(unreadablePath, "---\ndescription: Unreadable skill\n---\n");
		chmodSync(unreadablePath, 0);

		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ skills: [candidateDirectory] }),
			});

			const result = await loadWithHarness(loader);

			expect(result.diagnostics.some((diagnostic) => diagnostic.path === unreadablePath)).toBe(true);
		} finally {
			chmodSync(unreadablePath, 0o600);
		}
	});
});
