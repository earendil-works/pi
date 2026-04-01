import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnAgentsLedgerPath,
	createAlwaysOnTestHarness,
	loadAlwaysOnAgentRegistryModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on agent registry (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("creates the first agent with an auto-generated id, persisted execution tuple, and global default designation", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-agent-registry-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });

		const created = registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-03-31T13:55:00.000Z",
		});

		expect(created.agentId).toMatch(/^[a-z0-9][a-z0-9-]*$/i);
		expect(created.becameGlobalDefault).toBe(true);

		const state = registry.readState();
		expect(state).toEqual({
			agents: [
				{
					agentId: created.agentId,
					workspacePath: harness.workspaceDir,
					provider: "openai-codex",
					modelId: "gpt-5.4",
					thinkingLevel: "medium",
					enabled: true,
					createdAt: "2026-03-31T13:55:00.000Z",
				},
			],
			globalDefaultAgentId: created.agentId,
		});

		expect(readJsonl(alwaysOnAgentsLedgerPath(harness.configDir))).toEqual([
			{
				type: "agent_created",
				agentId: created.agentId,
				workspacePath: harness.workspaceDir,
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
				timestamp: "2026-03-31T13:55:00.000Z",
			},
			{
				type: "workspace_default_set",
				agentId: created.agentId,
				timestamp: "2026-03-31T13:55:00.000Z",
			},
		]);

		const surface = registry.renderAgentsTable();
		expect(surface).toContain(created.agentId);
		expect(surface).toContain(harness.workspaceDir);
		expect(surface).toContain("openai-codex");
		expect(surface).toContain("gpt-5.4");
		expect(surface).toContain("medium");
		expect(surface.toLowerCase()).toContain("global default");
	});
});
