import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;
const baseEntryUrl = new URL("../src/base.ts", import.meta.url).href;

const SDK_SPECIFIERS = [
	"@anthropic-ai/sdk",
	"openai",
	"@google/genai",
	"@mistralai/mistralai",
	"@aws-sdk/client-bedrock-runtime",
] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
	value?: unknown;
};

function runProbe(action: string, entryUrl = aiEntryUrl): ProbeResult {
	const script = `
		import { registerHooks } from "node:module";

		const targets = new Set(${JSON.stringify(SDK_SPECIFIERS)});
		const loaded = [];

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (targets.has(specifier)) {
					loaded.push(specifier);
				}
				return nextResolve(specifier, context);
			},
		});

		const mod = await import(${JSON.stringify(entryUrl)});
		const value = await (async () => {
			${action}
		})();
		console.log(JSON.stringify({ loadedSpecifiers: [...new Set(loaded)], value }));
	`;

	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("registers built-in transports when importing the root barrel", () => {
		const result = runProbe(`return mod.getApiProviders().map((provider) => provider.api).sort();`);
		expect(result.value).toEqual([
			"anthropic-messages",
			"azure-openai-responses",
			"bedrock-converse-stream",
			"google-generative-ai",
			"google-vertex",
			"mistral-conversations",
			"openai-codex-responses",
			"openai-completions",
			"openai-responses",
		]);
	});

	it("registers built-in image transports when importing the root barrel", () => {
		const result = runProbe(`return mod.getImagesApiProvider("openrouter-images")?.api;`);
		expect(result.loadedSpecifiers).toEqual([]);
		expect(result.value).toBe("openrouter-images");
	});

	it("does not load provider SDKs or register transports when importing the base barrel", () => {
		const result = runProbe(`return mod.getApiProviders().map((provider) => provider.api);`, baseEntryUrl);
		expect(result.loadedSpecifiers).toEqual([]);
		expect(result.value).toEqual([]);
	});

	it("loads only the Anthropic SDK when calling the root lazy wrapper", () => {
		const result = runProbe(`
			const model = {
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimpleAnthropic(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbe(`
			const model = mod.getModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimple(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("dispatches through a lazy wrapper again after resetting providers", () => {
		const result = runProbe(`
			const model = mod.getModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimple(model, context).result();
			mod.resetApiProviders();
			return (await mod.streamSimple(model, context).result()).stopReason;
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
		expect(result.value).toBe("error");
	});
});
