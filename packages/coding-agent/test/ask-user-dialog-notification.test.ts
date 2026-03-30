import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { playNotificationSoundMock, sendNotificationMock } = vi.hoisted(() => ({
	playNotificationSoundMock: vi.fn(),
	sendNotificationMock: vi.fn(),
}));

vi.mock("../src/notification.js", () => ({
	playNotificationSound: playNotificationSoundMock,
	sendNotification: sendNotificationMock,
}));

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface RendererHarness {
	stop(): void;
	runAskUserDialog(request: {
		mode: "clarify";
		objective: string;
		scopeName: string;
		questions: [
			{
				id: string;
				topic: string;
				prompt: string;
				options: string[];
			},
		];
	}): Promise<{ scopeName: string; answers: Array<{ answer: string }> }>;
	activeDialogOverlay: { handleInput(data: string): void } | null;
	footer: { getTitle(): string | null };
}

function submitDialog(renderer: RendererHarness, scopeName: string): void {
	const overlay = renderer.activeDialogOverlay;
	if (!overlay) {
		throw new Error("expected active ask-user dialog overlay");
	}
	for (const char of scopeName) {
		overlay.handleInput(char);
	}
	overlay.handleInput("\r");
	overlay.handleInput("\r");
}

async function makeRenderer(options?: {
	notificationBanner?: "native" | "none";
	notificationSound?: "tink" | "none";
}): Promise<{ renderer: RendererHarness; cleanup: () => void }> {
	initTheme("dark");
	const tempDir = mkdtempSync(join(tmpdir(), "mu-ask-user-notification-test-"));
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel: "medium",
		},
	});

	const settings = new SettingsManager(tempDir);
	settings.setNotificationBanner(options?.notificationBanner ?? "native");
	settings.setNotificationSound(options?.notificationSound ?? "tink");

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "ask-user-notification-test",
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
	);

	await renderer.init();
	return {
		renderer: renderer as unknown as RendererHarness,
		cleanup: () => {
			(renderer as unknown as RendererHarness).stop();
			rmSync(tempDir, { force: true, recursive: true });
		},
	};
}

describe("ask-user dialog notifications", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		playNotificationSoundMock.mockReset();
		sendNotificationMock.mockReset();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("notifies when ask_user opens a dialog", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const dialogPromise = renderer.runAskUserDialog({
			mode: "clarify",
			objective: "Lock down missing validation details",
			scopeName: "",
			questions: [
				{
					id: "surface",
					topic: "Surface",
					prompt: "Which surface should verify the flow?",
					options: ["xtui", "cdp"],
				},
			],
		});

		expect(playNotificationSoundMock).toHaveBeenCalledTimes(1);
		expect(sendNotificationMock).toHaveBeenCalledTimes(1);
		expect(sendNotificationMock).toHaveBeenCalledWith("Mu", "Input needed: ask_user");

		submitDialog(renderer, "login flow");
		await expect(dialogPromise).resolves.toMatchObject({
			scopeName: "login-flow",
			answers: [{ answer: "xtui" }],
		});
	});

	it("respects disabled ask_user notifications", async () => {
		const { renderer, cleanup } = await makeRenderer({
			notificationBanner: "none",
			notificationSound: "none",
		});
		cleanups.push(cleanup);

		const dialogPromise = renderer.runAskUserDialog({
			mode: "clarify",
			objective: "Lock down missing validation details",
			scopeName: "",
			questions: [
				{
					id: "surface",
					topic: "Surface",
					prompt: "Which surface should verify the flow?",
					options: ["xtui", "cdp"],
				},
			],
		});

		expect(playNotificationSoundMock).not.toHaveBeenCalled();
		expect(sendNotificationMock).not.toHaveBeenCalled();

		submitDialog(renderer, "login flow");
		await expect(dialogPromise).resolves.toMatchObject({
			scopeName: "login-flow",
			answers: [{ answer: "xtui" }],
		});
	});
});
