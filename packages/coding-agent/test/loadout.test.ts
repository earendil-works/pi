import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendSessionLoadout,
	createLoadoutResourceReference,
	getLatestLoadoutEntry,
	getLoadoutResourceReferenceKey,
	getSessionLoadout,
	LOADOUT_CUSTOM_TYPE,
	type LoadoutOverride,
	type LoadoutResourceReference,
	parseLoadoutEntryPayload,
	resolveLoadoutOverlay,
} from "../src/core/loadout.ts";
import type { ResolvedPaths, ResolvedResource } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const packageReference: LoadoutResourceReference = {
	type: "extension",
	origin: "package",
	source: "npm:test-package",
	relativePath: "extensions/test.ts",
};

function override(reference: LoadoutResourceReference, enabled: boolean): LoadoutOverride {
	return { reference, enabled };
}

describe("loadout session entries", () => {
	it("parses and validates versioned payloads defensively", () => {
		const input = {
			version: 1,
			overrides: [
				override(packageReference, true),
				override(
					{
						type: "skill",
						origin: "top-level",
						scope: "project",
						relativePath: "skills/review/SKILL.md",
					},
					false,
				),
			],
		};

		const parsed = parseLoadoutEntryPayload(input);
		expect(parsed).toEqual(input);
		expect(parsed).not.toBe(input);
		expect(parsed?.overrides[0].reference).not.toBe(input.overrides[0].reference);

		expect(parseLoadoutEntryPayload({ ...input, version: 2 })).toBeUndefined();
		expect(parseLoadoutEntryPayload({ version: 1, overrides: [{ reference: packageReference }] })).toBeUndefined();
		expect(
			parseLoadoutEntryPayload({
				version: 1,
				overrides: [
					override(
						{
							type: "prompt",
							origin: "top-level",
							scope: "user",
							relativePath: "../outside.md",
						},
						true,
					),
				],
			}),
		).toBeUndefined();
		expect(
			parseLoadoutEntryPayload({
				version: 1,
				overrides: [override(packageReference, true), override(packageReference, false)],
			}),
		).toBeUndefined();
	});

	it("uses the latest valid entry in file order, including reset markers", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(LOADOUT_CUSTOM_TYPE, { version: 1, overrides: [override(packageReference, true)] });
		const firstEntryId = session.getLeafId()!;
		session.appendCustomEntry(LOADOUT_CUSTOM_TYPE, { version: 99, overrides: [] });

		expect(getSessionLoadout(session)?.overrides).toEqual([override(packageReference, true)]);

		session.branch(firstEntryId);
		session.appendCustomEntry(LOADOUT_CUSTOM_TYPE, { version: 1, overrides: [] });
		session.branch(firstEntryId);

		expect(getSessionLoadout(session)).toEqual({ version: 1, overrides: [] });
		expect(getLatestLoadoutEntry(session.getEntries())).toEqual({ version: 1, overrides: [] });
	});

	it("writes non-empty changes and only the necessary reset tombstone", () => {
		const session = SessionManager.inMemory();
		expect(appendSessionLoadout(session, [])).toBeUndefined();
		expect(session.getEntries()).toHaveLength(0);

		expect(appendSessionLoadout(session, [override(packageReference, true)])).toBeTypeOf("string");
		expect(appendSessionLoadout(session, [override(packageReference, true)])).toBeUndefined();
		expect(session.getEntries()).toHaveLength(1);

		expect(appendSessionLoadout(session, [])).toBeTypeOf("string");
		expect(appendSessionLoadout(session, [])).toBeUndefined();
		expect(session.getEntries()).toHaveLength(2);
		expect(getSessionLoadout(session)).toEqual({ version: 1, overrides: [] });
	});
});

describe("loadout resource matching", () => {
	const options = { cwd: "/workspace/project", agentDir: "/home/test/.pi/agent" };

	it("matches package identity across versions and includes resource type", () => {
		const extension: ResolvedResource = {
			path: "/packages/test/extensions/shared.md",
			enabled: false,
			metadata: {
				source: "npm:test-package@2.0.0",
				scope: "user",
				origin: "package",
				baseDir: "/packages/test",
			},
		};
		const prompt: ResolvedResource = { ...extension };
		const oldReference = createLoadoutResourceReference(
			"extension",
			{ ...extension, metadata: { ...extension.metadata, source: "npm:test-package@1.0.0" } },
			options,
		)!;
		const resolved: ResolvedPaths = {
			extensions: [extension],
			skills: [],
			prompts: [prompt],
			themes: [],
		};

		const result = resolveLoadoutOverlay(resolved, [override(oldReference, true)], options);
		expect(result.resolvedPaths.extensions[0].enabled).toBe(true);
		expect(result.resolvedPaths.prompts[0].enabled).toBe(false);
		expect(getLoadoutResourceReferenceKey(oldReference)).not.toBe(
			getLoadoutResourceReferenceKey(createLoadoutResourceReference("prompt", prompt, options)!),
		);
		expect(result.snapshot.diagnostics).toEqual([]);
	});
});

describe("DefaultResourceLoader loadout overlay", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `loadout-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createResources(): void {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "toggle.ts"), "export default function() {}");
		mkdirSync(join(agentDir, "skills", "toggle"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "toggle", "SKILL.md"),
			"---\nname: toggle\ndescription: Toggle skill\n---\nSkill content",
		);
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(agentDir, "prompts", "toggle.md"), "Toggle prompt");
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		const theme = JSON.parse(
			readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
		) as { name: string };
		theme.name = "toggle-theme";
		writeFileSync(join(agentDir, "themes", "toggle.json"), JSON.stringify(theme));
	}

	function allResourceOverrides(loader: DefaultResourceLoader, enabled: boolean): LoadoutOverride[] {
		return loader.getLoadoutSnapshot().resources.map((resource) => override(resource.reference, enabled));
	}

	function expectAllLoaded(loader: DefaultResourceLoader, loaded: boolean): void {
		expect(loader.getExtensions().extensions.some((extension) => extension.path.endsWith("toggle.ts"))).toBe(loaded);
		expect(loader.getSkills().skills.some((skill) => skill.name === "toggle")).toBe(loaded);
		expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "toggle")).toBe(loaded);
		expect(loader.getThemes().themes.some((theme) => theme.name === "toggle-theme")).toBe(loaded);
	}

	it("turns disabled resources on for all four resource types", async () => {
		createResources();
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setExtensionPaths(["-extensions/toggle.ts"]);
		settingsManager.setSkillPaths(["-skills/toggle"]);
		settingsManager.setPromptTemplatePaths(["-prompts/toggle.md"]);
		settingsManager.setThemePaths(["-themes/toggle.json"]);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		expect(loader.getLoadoutSnapshot().resources).toHaveLength(4);
		expect(loader.getLoadoutSnapshot().resources.every((resource) => !resource.defaultEnabled)).toBe(true);
		expectAllLoaded(loader, false);

		loader.setLoadoutOverrides(allResourceOverrides(loader, true));
		await loader.reload();

		expectAllLoaded(loader, true);
		expect(loader.getLoadoutSnapshot().resources.every((resource) => resource.enabled)).toBe(true);
	});

	it("turns enabled resources off and preserves the overlay across ordinary reloads", async () => {
		createResources();
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expectAllLoaded(loader, true);

		loader.setLoadoutOverrides(allResourceOverrides(loader, false));
		await loader.reload();
		expectAllLoaded(loader, false);
		await loader.reload();
		expectAllLoaded(loader, false);
		expect(loader.getLoadoutSnapshot().overrides).toHaveLength(4);
	});

	it("preserves unmatched overrides and restores them if a resource returns", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		const promptReference: LoadoutResourceReference = {
			type: "prompt",
			origin: "top-level",
			scope: "user",
			relativePath: "prompts/later.md",
		};
		loader.setLoadoutOverrides([override(promptReference, false)]);
		await loader.reload();

		expect(loader.getLoadoutSnapshot().overrides).toEqual([override(promptReference, false)]);
		expect(loader.getLoadoutSnapshot().diagnostics[0]?.message).toContain("is unavailable");

		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(agentDir, "prompts", "later.md"), "Later prompt");
		await loader.reload();

		expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "later")).toBe(false);
		expect(loader.getLoadoutSnapshot().diagnostics).toEqual([]);
	});

	it("does not treat session references as path, package, or trust authority", async () => {
		const projectExtension = join(cwd, ".pi", "extensions", "untrusted.ts");
		const externalExtension = join(tempDir, "external.ts");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(projectExtension, "export default function() {}");
		writeFileSync(externalExtension, "export default function() {}");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		const payload = parseLoadoutEntryPayload({
			version: 1,
			overrides: [
				override(
					{
						type: "extension",
						origin: "top-level",
						scope: "project",
						relativePath: "extensions/untrusted.ts",
					},
					true,
				),
				override({ type: "extension", origin: "top-level", scope: "user", path: externalExtension }, true),
				override(
					{
						type: "extension",
						origin: "package",
						source: "npm:not-installed-by-loadout",
						relativePath: "extensions/index.ts",
					},
					true,
				),
			],
		})!;

		loader.setLoadoutOverrides(payload.overrides);
		await loader.reload();

		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getLoadoutSnapshot().diagnostics).toHaveLength(3);
		expect(loader.getLoadoutSnapshot().resources).toEqual([]);
	});
});
