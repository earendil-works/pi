import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "catalog", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id): [string, ModelsDevV2Model] => [
				id,
				{
					id,
					type: "chat",
					name: id,
					modalities: { input: ["text"], output: ["text"] },
					capabilities: {
						tools: { supported: id !== "deepseek-v4-flash-0731" },
						reasoning: { supported: false },
					},
					api: {},
				},
			]),
		);
		writeUpstreamMock(preloadPath, { "alibaba-token-plan": { models: sourceModels } });

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "catalog/generate.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
