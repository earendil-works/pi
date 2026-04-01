import { afterEach, describe, expect, it, vi } from "vitest";

import * as notificationModule from "../src/notification.js";

import {
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
} from "./fixtures/always-on-harness.js";

describe("always-on completion and blocker notifications (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("sends a visible notification when an always-on run completes", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-notify-complete-red-");
		cleanups.push(() => harness.cleanup());

		const sendNotificationSpy = vi.spyOn(notificationModule, "sendNotification").mockImplementation(() => {});

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T01:10:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T01:10:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		await supervisor.submitImmediateWork({ instruction: "Complete successfully" });
		await supervisor.drainOnce();

		expect(sendNotificationSpy).toHaveBeenCalled();
		expect(sendNotificationSpy.mock.calls[0]?.join(" ").toLowerCase()).toContain("completed");
	});

	it("sends a visible notification when an always-on run ends blocked", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-notify-blocked-red-");
		cleanups.push(() => harness.cleanup());

		const sendNotificationSpy = vi.spyOn(notificationModule, "sendNotification").mockImplementation(() => {});

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T01:11:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T01:11:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: () => ({
				sessionId: "blocked-session-id",
				completion: Promise.resolve({
					outcome: "blocked",
					errorMessage: "Waiting on explicit human guidance",
				}),
			}),
		});

		await supervisor.submitImmediateWork({ instruction: "Block and notify" });
		await supervisor.drainOnce();

		expect(sendNotificationSpy).toHaveBeenCalled();
		expect(sendNotificationSpy.mock.calls[0]?.join(" ").toLowerCase()).toContain("blocked");
	});
});
