import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const customDirectory = resolve(__dirname, "../../fixtures/skills/custom-directory");
const readmePath = join(customDirectory, "README.md");
const brokenFrontmatterPath = join(customDirectory, "broken-frontmatter.md");

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

	it.each([
		[
			"settings",
			() =>
				new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: SettingsManager.inMemory({ skills: [customDirectory] }),
				}),
		],
		[
			"CLI",
			() =>
				new DefaultResourceLoader({
					cwd,
					agentDir,
					additionalSkillPaths: [customDirectory],
				}),
		],
	])("ignores root documentation in %s directories", async (_source, createLoader) => {
		expectCustomDirectoryLoaded(await loadWithHarness(createLoader()));
	});

	it.each([readmePath, brokenFrontmatterPath])(
		"ignores explicitly configured non-skill Markdown files",
		async (filePath) => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ skills: [filePath] }),
			});

			const result = await loadWithHarness(loader);

			expect(result.skills.some((skill) => skill.filePath === filePath)).toBe(false);
			expect(result.diagnostics.filter((diagnostic) => diagnostic.path === filePath)).toEqual([]);
		},
	);

	it.skipIf(process.platform === "win32")("reports unreadable skill files", async () => {
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
