import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevV2Catalog, ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function claudeModel(id: string, reasoning: ModelsDevV2Model["capabilities"]["reasoning"], canonicalId?: string) {
	return {
		id,
		...(canonicalId ? { canonical_id: canonicalId } : {}),
		type: "chat",
		name: id,
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning },
		api: {},
	} satisfies ModelsDevV2Model;
}

function generateCatalog(modelsDev: ModelsDevV2Catalog, provider: string): Record<string, Model<Api>> {
	const root = mkdtempSync(join(tmpdir(), "pi-claude-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	writeUpstreamMock(preloadPath, modelsDev);
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preloadPath).href, "catalog/generate.ts", "--json-only", "--json-output", outputPath],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8")) as Record<
		string,
		Model<Api>
	>;
}

const effort: NonNullable<ModelsDevV2Model["capabilities"]["reasoning"]["effort"]> = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

describe("Claude thinking off", () => {
	// Copilot lists no thinking toggle on any Claude model; Sonnet 5.5 rejects `disabled` there (#12429).
	it("follows the thinking toggle of Anthropic's own models.dev entry on other hosts", () => {
		const models = generateCatalog(
			{
				anthropic: {
					models: {
						"claude-sonnet-5-5": claudeModel("claude-sonnet-5-5", { supported: true, effort }),
						"claude-haiku-5-5": claudeModel("claude-haiku-5-5", { supported: true, toggle: true, effort }),
					},
				},
				"github-copilot": {
					models: {
						"claude-sonnet-5.5": claudeModel(
							"claude-sonnet-5.5",
							{ supported: true, effort },
							"anthropic/claude-sonnet-5-5",
						),
						"claude-haiku-5.5": claudeModel(
							"claude-haiku-5.5",
							{ supported: true, effort },
							"anthropic/claude-haiku-5-5",
						),
					},
				},
			},
			"github-copilot",
		);
		expect(getSupportedThinkingLevels(models["claude-sonnet-5.5"])).not.toContain("off");
		expect(getSupportedThinkingLevels(models["claude-haiku-5.5"])).toContain("off");
	});

	it("finds Anthropic's entry through canonical_id when the host id does not resemble Anthropic's", () => {
		const models = generateCatalog(
			{
				anthropic: {
					models: { "claude-sonnet-5-5": claudeModel("claude-sonnet-5-5", { supported: true, effort }) },
				},
				"amazon-bedrock": {
					models: {
						"us.anthropic.claude-sonnet-5-5": claudeModel(
							"us.anthropic.claude-sonnet-5-5",
							{ supported: true, effort },
							"anthropic/claude-sonnet-5-5",
						),
					},
				},
			},
			"amazon-bedrock",
		);
		expect(getSupportedThinkingLevels(models["us.anthropic.claude-sonnet-5-5"])).not.toContain("off");
	});

	it("keeps thinking off unsupported on the authored Fable 5.2 when models.dev does not list it", () => {
		const models = generateCatalog({}, "anthropic");
		expect(getSupportedThinkingLevels(models["claude-fable-5-2"])).not.toContain("off");
	});
});
