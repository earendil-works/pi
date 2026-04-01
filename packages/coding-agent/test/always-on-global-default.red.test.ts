import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnAgentsLedgerPath,
	createAlwaysOnTestHarness,
	loadAlwaysOnAgentRegistryModule,
	readJsonl,
	writeJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on global default resolution (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("keeps the original global default until set-default explicitly switches to another agent", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-global-default-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });

		registry.createAgent({
			agentId: "alpha",
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-03-31T13:55:00.000Z",
		});
		registry.createAgent({
			agentId: "beta",
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			timestamp: "2026-03-31T13:56:00.000Z",
		});

		expect(registry.readState().globalDefaultAgentId).toBe("alpha");

		registry.setGlobalDefaultAgent({
			agentId: "beta",
			timestamp: "2026-03-31T13:57:00.000Z",
		});

		const reloaded = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		expect(reloaded.readState().globalDefaultAgentId).toBe("beta");

		expect(readJsonl(alwaysOnAgentsLedgerPath(harness.configDir))).toEqual([
			{
				type: "agent_created",
				agentId: "alpha",
				workspacePath: harness.workspaceDir,
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
				timestamp: "2026-03-31T13:55:00.000Z",
			},
			{
				type: "workspace_default_set",
				agentId: "alpha",
				timestamp: "2026-03-31T13:55:00.000Z",
			},
			{
				type: "agent_created",
				agentId: "beta",
				workspacePath: harness.workspaceDir,
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "low",
				timestamp: "2026-03-31T13:56:00.000Z",
			},
			{
				type: "workspace_default_set",
				agentId: "beta",
				timestamp: "2026-03-31T13:57:00.000Z",
			},
		]);

		expect(reloaded.renderStatus({ agentId: "beta" })).toContain("beta");
		expect(reloaded.renderStatus({ agentId: "beta" }).toLowerCase()).toContain("global default");
		expect(reloaded.renderStatus({ agentId: "alpha" }).toLowerCase()).not.toContain("global default");
	});

	it("fails clearly when resolving an untargeted command without a global default agent", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-missing-default-red-");
		cleanups.push(() => harness.cleanup());

		writeJsonl(alwaysOnAgentsLedgerPath(harness.configDir), []);

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });

		expect(() => registry.resolveTargetAgent({})).toThrow(/no global default always-on agent exists/i);
	});

	it("fails clearly when set-default names an unknown agent id", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-missing-agent-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });

		expect(() =>
			registry.setGlobalDefaultAgent({
				agentId: "missing-agent",
				timestamp: "2026-03-31T13:58:00.000Z",
			}),
		).toThrow(/agent .*missing-agent.* not found/i);
	});
});
