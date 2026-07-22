import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalZaiCodingCnApiKey = process.env.ZAI_CODING_CN_API_KEY;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalZaiCodingCnApiKey === undefined) {
		delete process.env.ZAI_CODING_CN_API_KEY;
	} else {
		process.env.ZAI_CODING_CN_API_KEY = originalZaiCodingCnApiKey;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("resolves ZAI China Coding Plan credentials from ZAI_CODING_CN_API_KEY", () => {
		process.env.ZAI_CODING_CN_API_KEY = "zai-coding-cn-token";

		expect(findEnvKeys("zai-coding-cn")).toEqual(["ZAI_CODING_CN_API_KEY"]);
		expect(getEnvApiKey("zai-coding-cn")).toBe("zai-coding-cn-token");
	});

	it("resolves every StepFun provider from a shared STEPFUN_API_KEY", () => {
		const original = process.env.STEPFUN_API_KEY;
		process.env.STEPFUN_API_KEY = "stepfun-token";
		try {
			for (const provider of ["stepfun", "stepfun-ai", "stepfun-step-plan", "stepfun-ai-step-plan"] as const) {
				expect(findEnvKeys(provider)).toEqual(["STEPFUN_API_KEY"]);
				expect(getEnvApiKey(provider)).toBe("stepfun-token");
			}
		} finally {
			if (original === undefined) delete process.env.STEPFUN_API_KEY;
			else process.env.STEPFUN_API_KEY = original;
		}
	});
});
