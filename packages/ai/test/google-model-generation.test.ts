import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import type { Api, Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function googleModel(id: string, input: string[]): ModelsDevV2Model {
	return {
		id,
		type: "chat",
		name: id,
		modalities: { input, output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		api: {},
	};
}

function generateGoogleModels(models: ModelsDevV2Model[]): Record<string, Model<Api>> {
	const root = mkdtempSync(join(tmpdir(), "pi-google-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	writeUpstreamMock(preloadPath, {
		google: { models: Object.fromEntries(models.map((model) => [model.id, model])) },
	});
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preloadPath).href, "catalog/generate.ts", "--json-only", "--json-output", outputPath],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return JSON.parse(readFileSync(join(outputPath, "providers/google.json"), "utf8")) as Record<string, Model<Api>>;
}

describe("Google model generation", () => {
	it("declares the modalities models.dev lists, including audio and video", () => {
		const models = generateGoogleModels([
			googleModel("gemini-3.8-flash", ["text", "image", "audio", "video"]),
			googleModel("gemini-text-only", ["text"]),
			googleModel("gemini-image-only", ["text", "image"]),
		]);

		expect(models["gemini-3.8-flash"].input).toEqual(["text", "image", "audio", "video"]);
		expect(models["gemini-text-only"].input).toEqual(["text"]);
		expect(models["gemini-image-only"].input).toEqual(["text", "image"]);
	});

	it("always lists text, even when models.dev does not", () => {
		const models = generateGoogleModels([googleModel("gemini-audio-only", ["audio"])]);

		expect(models["gemini-audio-only"].input).toEqual(["text", "audio"]);
	});
});
