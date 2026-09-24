import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

test("publishes explicit per-type and total model counts", (t) => {
	const input = mkdtempSync(join(tmpdir(), "pi-model-catalog-counts-"));
	t.after(() => rmSync(input, { recursive: true, force: true }));
	const providersDir = join(input, "providers");
	mkdirSync(providersDir);

	const chatModels = Array.from({ length: 500 }, (_, index) => ({
		type: "chat",
		id: `chat-${index}`,
		provider: "anthropic",
	}));
	const allModels = {
		anthropic: chatModels,
		openai: [],
		openrouter: [
			{ type: "image", id: "shared", provider: "openrouter" },
			{ type: "classifier", id: "shared", provider: "openrouter" },
		],
	};
	const models = {
		anthropic: Object.fromEntries(chatModels.map((model) => [model.id, model])),
		openai: {},
		openrouter: {},
	};
	const providerIds = Object.keys(allModels).sort();
	writeJson(join(input, "models.json"), models);
	writeJson(join(input, "models.all.json"), allModels);
	writeJson(join(input, "providers.json"), providerIds);
	for (const providerId of providerIds) {
		writeJson(join(providersDir, `${providerId}.json`), models[providerId]);
		writeJson(join(providersDir, `${providerId}.all.json`), allModels[providerId]);
	}

	const result = spawnSync(
		process.execPath,
		[
			"scripts/publish-model-catalog.mjs",
			"--input",
			input,
			"--source-commit",
			"test-commit",
			"--dry-run",
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const publication = JSON.parse(readFileSync(join(input, "publication.json"), "utf8"));
	assert.equal(publication.modelCount, 500);
	assert.equal(publication.chatModelCount, 500);
	assert.equal(publication.imageModelCount, 1);
	assert.equal(publication.classifierModelCount, 1);
	assert.equal(publication.totalModelCount, 502);
});
