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

function sourceModel(id: string, api: ModelsDevV2Model["api"]): ModelsDevV2Model {
	return {
		id,
		type: "chat",
		name: id,
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		api,
	};
}

function generateOpencodeModels(models: ModelsDevV2Model[], strict = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-opencode-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	writeUpstreamMock(preloadPath, {
		opencode: { models: Object.fromEntries(models.map((model) => [model.id, model])) },
	});
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"catalog/generate.ts",
			...(strict ? ["--strict"] : []),
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	return {
		result,
		models: () =>
			JSON.parse(readFileSync(join(outputPath, "providers/opencode.json"), "utf8")) as Record<string, Model<Api>>,
	};
}

describe("OpenCode model generation", () => {
	it("uses the protocol and base URL models.dev lists for each model", () => {
		const base = "https://example.test/zen";
		const { result, models } = generateOpencodeModels([
			sourceModel("chat", { "chat-completions": { base_url: `${base}/openai/v1` } }),
			sourceModel("responses", { responses: { base_url: `${base}/openai/v1` } }),
			sourceModel("messages", { messages: { base_url: `${base}/anthropic/v1` } }),
			sourceModel("gemini", { "generate-content": { base_url: `${base}/google/v1beta` } }),
			// Native protocols win over Chat Completions regardless of listing order.
			sourceModel("both", {
				"chat-completions": { base_url: `${base}/openai/v1` },
				messages: { base_url: `${base}/anthropic/v1` },
			}),
			sourceModel("live", { "bidi-generate-content": { base_url: `${base}/google/v1beta` } }),
		]);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toContain("models.dev lists no supported API for opencode/live (bidi-generate-content)");

		const generated = models();
		const endpoints = Object.fromEntries(
			Object.values(generated).map((model) => [model.id, { api: model.api, baseUrl: model.baseUrl }]),
		);
		expect(endpoints).toEqual({
			chat: { api: "openai-completions", baseUrl: `${base}/openai/v1` },
			responses: { api: "openai-responses", baseUrl: `${base}/openai/v1` },
			// The Anthropic SDK appends /v1/messages itself.
			messages: { api: "anthropic-messages", baseUrl: `${base}/anthropic` },
			gemini: { api: "google-generative-ai", baseUrl: `${base}/google/v1beta` },
			both: { api: "anthropic-messages", baseUrl: `${base}/anthropic` },
		});
	});

	it("fails strict generation for a model without a supported protocol", () => {
		const { result } = generateOpencodeModels(
			[sourceModel("live", { "bidi-generate-content": { base_url: "https://example.test/google/v1beta" } })],
			true,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("models.dev lists no supported API for opencode/live (bidi-generate-content)");
	});
});
