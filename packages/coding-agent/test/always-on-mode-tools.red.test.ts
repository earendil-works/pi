import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { type AgentTool, getModel } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { allTools } from "../src/tools/index.js";
import type { ToolSelection } from "../src/tools/tool-selection.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type AlwaysOnToolsRenderer = {
	init(): Promise<void>;
	stop(): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	agent: {
		state: {
			tools: Array<AgentTool<TSchema, unknown>>;
			systemPrompt?: string;
		};
	};
};

function createExtensionManagerStub() {
	return {
		listCommands: () => [],
		getCommand: () => undefined,
		getIndicators: () => [],
		applyInputHooks: async (text: string) => ({ handled: false, text }),
		composeToolResultTransformer: <T>(base: T) => base,
	};
}

describe("always-on mode tools and prompt (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("adds always-on mode tools and prompt state on entry, then removes them on exit", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-tools-red-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const baseSelection: ToolSelection = {
			toolNames: ["read"],
			tools: [allTools.read] as unknown as Array<AgentTool<TSchema, unknown>>,
			replacedWithApplyPatch: false,
		};

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
				tools: baseSelection.tools,
				systemPrompt: "base:read",
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "always-on-tools-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
			null,
			null,
			[],
			() => baseSelection,
			async (tools) => tools.map((tool) => tool.name).join(","),
		) as unknown as AlwaysOnToolsRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		expect(renderer.agent.state.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(renderer.agent.state.systemPrompt).toBe("base:read");

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		expect(renderer.agent.state.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["always_on_snapshot", "always_on_submit"]),
		);
		expect(renderer.agent.state.systemPrompt).toContain("always_on_submit");

		await renderer.handleEditorTextSubmission("/always-on-exit", "by-end");
		expect(renderer.agent.state.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(renderer.agent.state.systemPrompt).toBe("base:read");
	});
});
