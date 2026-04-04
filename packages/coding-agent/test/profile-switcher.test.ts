import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildDefaultProfilesConfig,
	parseModelRef,
	updateAgentProfileContent,
} from "../examples/extensions/profile-switcher/profiles.js";
import { loadExtensions } from "../src/core/extensions/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("profile switcher extension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-switcher-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers the profile command", async () => {
		const extPath = path.resolve(__dirname, "../examples/extensions/profile-switcher");
		const result = await loadExtensions([extPath], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("profile")).toBe(true);
	});

	it("parses model refs with optional thinking", () => {
		const gpt = parseModelRef("factory-openai/gpt-5.4:xhigh");
		expect(gpt.provider).toBe("factory-openai");
		expect(gpt.modelId).toBe("gpt-5.4");
		expect(gpt.thinkingLevel).toBe("xhigh");
		expect(gpt.fullId).toBe("factory-openai/gpt-5.4");

		const nested = parseModelRef("vercel-ai-gateway/anthropic/claude-opus-4-6");
		expect(nested.provider).toBe("vercel-ai-gateway");
		expect(nested.modelId).toBe("anthropic/claude-opus-4-6");
		expect(nested.thinkingLevel).toBeNull();
	});

	it("updates agent model frontmatter without touching the body", () => {
		const source = [
			"---",
			"name: debug",
			"tools: read, bash",
			"model: factory-openai/gpt-5.4:xhigh",
			"---",
			"",
			"# Debug",
			"",
			"Body",
		].join("\n");

		const updated = updateAgentProfileContent(source, {
			model: "factory-openai/claude-opus-4-6:xhigh",
			fallbackModel: "factory-openai/claude-opus-4-6:xhigh",
		});

		expect(updated).toContain("model: factory-openai/claude-opus-4-6:xhigh");
		expect(updated).toContain("fallback-model: factory-openai/claude-opus-4-6:xhigh");
		expect(updated).toContain("# Debug\n\nBody");
	});

	it("builds default openai and anthropic profiles from disk", () => {
		const agentDir = path.join(tempDir, "agent");
		const agentsDir = path.join(agentDir, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify(
				{
					defaultProvider: "factory-openai",
					defaultModel: "gpt-5.4",
					defaultThinkingLevel: "xhigh",
					enabledModels: ["factory-openai/gpt-5.4", "factory-openai/gpt-5.4-mini"],
				},
				null,
				2,
			),
		);

		fs.writeFileSync(
			path.join(agentsDir, "debug.md"),
			[
				"---",
				"name: debug",
				"tools: read, bash",
				"model: factory-openai/gpt-5.4:xhigh",
				"fallback-model: factory-openai/gpt-5.4:xhigh",
				"---",
				"",
				"# Debug",
			].join("\n"),
		);

		const config = buildDefaultProfilesConfig(
			agentDir,
			new Set([
				"factory-openai/gpt-5.4",
				"factory-openai/gpt-5.4-mini",
				"factory-openai/claude-opus-4-6",
				"factory-openai/claude-sonnet-4-6",
			]),
		);

		expect(config.activeProfile).toBe("openai");
		expect(config.profiles.openai.main.model).toBe("factory-openai/gpt-5.4:xhigh");
		expect(config.profiles.openai.agents.debug.model).toBe("factory-openai/gpt-5.4:xhigh");
		expect(config.profiles.anthropic.main.model).toBe("factory-openai/claude-opus-4-6:xhigh");
		expect(config.profiles.anthropic.agents.debug.model).toBe("factory-openai/claude-sonnet-4-6:xhigh");
	});
});
