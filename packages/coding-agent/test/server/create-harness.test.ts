import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { buildCodingAgentHarnessSystemPrompt, createCodingAgentHarness } from "../../src/server/create-harness.ts";

describe("coding-agent Harness construction", () => {
	test("adds coding-agent policy to explicit Harness options", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "harness-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			streamOptions: { maxTokens: 123 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
			steeringMode: "all",
			followUpMode: "all",
		});
		try {
			expect(created.suspended).toEqual([]);
			expect(await created.harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
			expect(await created.harness.getStreamOptions()).toEqual({ maxTokens: 123 });
			expect(await created.harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });
			expect(await created.harness.getSteeringMode()).toBe("all");
			expect(await created.harness.getFollowUpMode()).toBe("all");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("preserves coding-agent prompt snippets and guideline order", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt("/workspace");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
		expect(prompt).toContain("Use read to examine files instead of cat or sed.");
		expect(prompt).toContain("Inspect PI_* environment variables for current model and session details.");
		expect(prompt.indexOf("Inspect PI_* environment variables")).toBeLessThan(
			prompt.indexOf("Use read to examine files"),
		);
	});
});
