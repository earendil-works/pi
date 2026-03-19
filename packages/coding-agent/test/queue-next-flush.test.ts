import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

describe("queue next flush", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("clears a queued-next entry when the injected user message uses split timestamp and prompt text blocks", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-queue-next-flush-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "off",
			},
		});

		const settings = new SettingsManager(configDir);
		settings.setNotificationBanner("none");
		settings.setNotificationSound("none");

		const renderer = new TuiRenderer(
			agent,
			{
				loadTitle: () => null,
				getSessionId: () => "queue-next-flush-test",
			} as never,
			settings,
			{
				listCommands: () => [],
				getCommand: () => undefined,
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as {
			init(): Promise<void>;
			stop(): void;
			handleEvent(event: unknown, state: unknown): Promise<void>;
			queuedMessages: Array<{ raw: string; sent: string; kind: "by-end" | "next" }>;
		};

		await renderer.init();
		cleanups.push(() => renderer.stop());

		renderer.queuedMessages.push({
			raw: "put this in the runbook",
			sent: "put this in the runbook",
			kind: "next",
		});

		await renderer.handleEvent(
			{
				type: "message_start",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "<user_message_time>Thursday, March 19, 2026 at 8:59 PM GMT+8</user_message_time>",
						},
						{ type: "text", text: "put this in the runbook" },
					],
					timestamp: Date.now(),
				},
			},
			agent.state,
		);

		expect(renderer.queuedMessages).toHaveLength(0);
	});
});
