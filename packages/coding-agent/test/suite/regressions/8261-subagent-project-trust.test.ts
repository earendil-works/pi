import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import subagentExtension from "../../../examples/extensions/subagent/index.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { createHarness, getMessageText } from "../harness.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/missing-user-agent-dir",
	getMarkdownTheme: () => ({}),
	parseFrontmatter: (content: string) => ({
		frontmatter: { name: "project-agent", description: "Project test agent" },
		body: content,
	}),
	withFileMutationQueue: async (_path: string, fn: () => Promise<unknown>) => fn(),
}));

interface RunOptions {
	trusted: boolean;
	confirmResult?: boolean;
}

async function runProjectAgent(options: RunOptions): Promise<{ confirmCalls: number; toolResult: string }> {
	const harness = await createHarness({ extensionFactories: [subagentExtension] });
	const confirm = vi.fn(async () => options.confirmResult ?? false);

	try {
		const agentsDir = join(harness.tempDir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: Project test agent\n---\n\nHandle the delegated task.\n",
		);
		harness.settingsManager.setProjectTrusted(options.trusted);

		await harness.session.bindExtensions({
			uiContext: { confirm } as unknown as ExtensionUIContext,
			mode: "tui",
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", {
					agent: "project-agent",
					task: "Test project trust",
					agentScope: "project",
					cwd: join(harness.tempDir, "missing-cwd"),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delegate this task");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		return {
			confirmCalls: confirm.mock.calls.length,
			toolResult: getMessageText(toolResult),
		};
	} finally {
		harness.cleanup();
	}
}

describe("regression #8261: subagent project trust", () => {
	it("skips per-call confirmation for trusted projects", async () => {
		const result = await runProjectAgent({ trusted: true });

		expect(result.confirmCalls).toBe(0);
		expect(result.toolResult).not.toContain("Canceled:");
	});

	it("keeps confirmation for untrusted interactive projects", async () => {
		const result = await runProjectAgent({ trusted: false, confirmResult: false });

		expect(result.confirmCalls).toBe(1);
		expect(result.toolResult).toContain("Canceled: project-local agents not approved.");
	});
});
