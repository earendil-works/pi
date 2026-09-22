import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { renderConfigSchemas } from "../scripts/generate-schemas.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { KeybindingsSchema } from "../src/core/keybindings-schema.ts";
import { ModelConfig, ModelsConfigSchema } from "../src/core/model-config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";

const schemaBaseUrl = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/schemas";
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-config-schema-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function schemaUrl(name: "models" | "settings" | "keybindings" | "theme"): string {
	return `${schemaBaseUrl}/${name}.schema.json`;
}

describe("generated configuration schemas", () => {
	it("matches the four committed artifacts", () => {
		const rendered = renderConfigSchemas();
		expect([...rendered.keys()]).toEqual([
			"schemas/models.schema.json",
			"schemas/settings.schema.json",
			"schemas/keybindings.schema.json",
			"schemas/theme.schema.json",
		]);
		for (const [relativePath, expected] of rendered) {
			expect(
				readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8"),
				`${relativePath} is stale; run npm run generate:schemas`,
			).toBe(expected);
		}
	});

	it("preserves editor guidance in the generated theme schema", () => {
		const schema = JSON.parse(renderConfigSchemas().get("schemas/theme.schema.json") ?? "");
		expect(schema).toMatchObject({
			title: "Pi Coding Agent Theme",
			description: "Theme schema for Pi coding agent",
			properties: {
				colors: {
					description: expect.stringContaining("use compatible fallbacks"),
					properties: {
						scrollbarTrack: { description: expect.stringContaining("falls back to muted") },
						accent: {
							description: "Primary accent color (logo, selected items, cursor)",
							anyOf: [{ description: expect.stringContaining("Hex color") }, expect.any(Object)],
						},
					},
				},
				export: { description: expect.stringContaining("defaults derived from userMessageBg") },
			},
		});
	});

	it.each([
		{
			name: "models.json",
			schema: ModelsConfigSchema,
			valid: {
				providers: {
					local: {
						compat: {
							zaiToolStream: true,
							thinkingTokenBudgetField: "thinking_budget",
							chatTemplateKwargs: { budget: { $var: "thinking.budget" } },
							supportsMidConvoSystemMessages: true,
						},
						models: [
							{
								id: "model",
								inputLimits: { maxRequestBytes: 1024, images: { maxPerRequest: 2 } },
								promptCache: { short: 300 },
							},
						],
					},
				},
			},
			invalid: { providers: { local: { models: [{ id: "" }] } } },
		},
		{
			name: "settings.json",
			schema: SettingsSchema,
			valid: {
				theme: "dark",
				cacheWarming: "idle",
				extensionSetting: { enabled: true },
				queueMode: "all",
				websockets: true,
				skills: { enableSkillCommands: true, customDirectories: ["./skills"] },
				retry: { maxDelayMs: 1000 },
			},
			invalid: { cacheWarming: "always" },
		},
		{
			name: "keybindings.json",
			schema: KeybindingsSchema,
			valid: { "app.session.new": "ctrl+n", "extension.action": ["alt+x"] },
			invalid: { "app.session.new": 42 },
		},
	])("validates representative $name documents", ({ schema, valid, invalid }) => {
		const validator = Compile(schema);
		expect(validator.Check(valid)).toBe(true);
		expect(validator.Check(invalid)).toBe(false);
	});

	it("accepts custom compatibility settings and rejects malformed known fields", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "models.json");
		const compat = {
			customOption: "value",
			supportsStore: true,
			supportsAdditionalTools: true,
		};
		writeFileSync(path, JSON.stringify({ providers: { demo: { api: "custom-api", compat } } }));

		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("demo")?.compat).toEqual(compat);

		writeFileSync(path, JSON.stringify({ providers: { demo: { compat: { supportsLongCacheRetention: "yes" } } } }));
		expect((await ModelConfig.load(path)).getError()).toContain("Invalid models.json schema");
	});

	it("accepts $schema in models.json without changing model validation", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				$schema: schemaUrl("models"),
				providers: { demo: { baseUrl: "http://localhost:8080/v1", models: [{ id: "demo" }] } },
			}),
		);

		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("demo")?.models?.[0]?.id).toBe("demo");

		writeFileSync(
			path,
			JSON.stringify({ $schema: schemaUrl("models"), providers: { demo: { models: [{ id: "" }] } } }),
		);
		expect((await ModelConfig.load(path)).getError()).toContain("Invalid models.json schema");
	});

	it("accepts $schema in settings.json and preserves unknown settings", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "settings.json"),
			JSON.stringify({ $schema: schemaUrl("settings"), theme: "light", extensionSetting: { enabled: true } }),
		);

		const manager = SettingsManager.create(directory, directory);
		expect(manager.getTheme()).toBe("light");
		expect(manager.getGlobalSettings()).toMatchObject({
			$schema: schemaUrl("settings"),
			extensionSetting: { enabled: true },
		});
	});

	it("accepts $schema in keybindings.json without treating it as an action", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "keybindings.json"),
			JSON.stringify({ $schema: schemaUrl("keybindings"), "app.session.new": "ctrl+n" }),
		);

		const manager = KeybindingsManager.create(directory);
		expect(manager.getUserBindings()).toEqual({ "app.session.new": "ctrl+n" });
		expect(manager.getEffectiveConfig()["app.session.new"]).toBe("ctrl+n");
	});

	it("accepts $schema in themes and rejects malformed themes", () => {
		const builtIn = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as Record<string, unknown>;
		expect(validateThemeJson("custom", { ...builtIn, $schema: schemaUrl("theme"), name: "custom" }).name).toBe(
			"custom",
		);
		expect(() => validateThemeJson("invalid", { ...builtIn, name: "invalid/name" })).toThrow(
			"theme names cannot contain",
		);
		expect(() => validateThemeJson("invalid", { ...builtIn, colors: {} })).toThrow("Missing required color tokens");
		for (const invalid of [
			{ ...builtIn, unexpected: true },
			{
				...builtIn,
				colors: { ...(builtIn.colors as Record<string, unknown>), scrollbarThmb: "" },
			},
			{ ...builtIn, export: { unexpected: "" } },
		]) {
			expect(() => validateThemeJson("invalid", invalid)).toThrow(/additional properties/i);
		}
	});
});
