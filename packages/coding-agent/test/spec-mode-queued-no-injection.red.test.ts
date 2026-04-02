import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

const SPEC_REMINDER = "\n\n## Specification Notes:\nInjected by spec mode";

describe("spec/discover prompt injection is skipped for queued messages", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	async function createRenderer(overrides?: {
		getCommand?: (
			name: string,
		) => { name: string; execute: (argString: string, ctx: unknown) => Promise<void> | void } | undefined;
		listCommands?: () => Array<{ name: string; execute: (argString: string, ctx: unknown) => Promise<void> | void }>;
	}) {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-spec-queued-"));
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

		const applyInputHooks = vi.fn(async (text: string) => ({
			handled: false,
			text: `${text}${SPEC_REMINDER}`,
		}));

		const renderer = new TuiRenderer(
			agent,
			{
				loadTitle: () => null,
				getSessionId: () => "spec-queued-no-injection-test",
			} as never,
			settings,
			{
				listCommands: overrides?.listCommands ?? (() => []),
				getCommand: overrides?.getCommand ?? (() => undefined),
				getIndicators: () => [],
				applyInputHooks,
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as {
			init(): Promise<void>;
			stop(): void;
			handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
			queuedMessages: Array<{ raw: string; sent: string; kind: "by-end" | "next" }>;
			onInputCallback?: (text: string) => void;
		};

		await renderer.init();
		cleanups.push(() => renderer.stop());

		return { agent, renderer, applyInputHooks };
	}

	it.each(["by-end", "next"] as const)(
		"does not inject spec/discover reminder when submission is queued as %s",
		async (kind) => {
			const { agent, renderer, applyInputHooks } = await createRenderer();
			agent.state.isStreaming = true;

			await renderer.handleEditorTextSubmission("summarize this", kind);

			expect(renderer.queuedMessages).toHaveLength(1);
			expect(renderer.queuedMessages[0]).toEqual({
				raw: "summarize this",
				sent: "summarize this",
				kind,
			});
			expect(applyInputHooks).not.toHaveBeenCalled();
		},
	);

	it("still applies input hooks for non-queued submissions", async () => {
		const { agent, renderer, applyInputHooks } = await createRenderer();
		agent.state.isStreaming = false;

		const onInputCallback = vi.fn();
		renderer.onInputCallback = onInputCallback;

		await renderer.handleEditorTextSubmission("summarize this", "by-end");

		expect(applyInputHooks).toHaveBeenCalledWith("summarize this");
		expect(onInputCallback).toHaveBeenCalledWith(`summarize this${SPEC_REMINDER}`);
	});

	it("still executes slash commands while streaming", async () => {
		const execute = vi.fn();
		const { agent, renderer, applyInputHooks } = await createRenderer({
			getCommand: (name: string) =>
				name === "spec"
					? {
							name: "spec",
							execute,
						}
					: undefined,
		});
		agent.state.isStreaming = true;

		await renderer.handleEditorTextSubmission("/spec", "next");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(renderer.queuedMessages).toHaveLength(0);
		expect(applyInputHooks).not.toHaveBeenCalled();
	});
});
