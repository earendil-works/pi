import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Tool, type TranscriptCapabilities } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	buildSystemPromptDefinition,
	diffSystemPrompts,
	normalizeBuildSystemPromptOptions,
	prepareModelContextUpdate,
} from "../src/core/system-prompt.ts";
import type { ExtensionFactory } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

const nativeCapabilities: TranscriptCapabilities = {
	midConversationSystemMessages: true,
	midConversationToolAdditions: true,
	midConversationToolRemovals: true,
};

const noCapabilities: TranscriptCapabilities = {
	midConversationSystemMessages: false,
	midConversationToolAdditions: false,
	midConversationToolRemovals: false,
};

const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });

describe("system prompt updates", () => {
	test("persists one initial system message across resume", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-system-prompt-resume-"));
		try {
			const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
			const first = await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: SettingsManager.inMemory(),
				sessionManager,
				noTools: "all",
			});
			const sessionFile = first.session.sessionFile!;
			expect(first.session.messages.map((message) => message.role)).toEqual(["system"]);
			first.session.dispose();

			const resumedManager = SessionManager.open(sessionFile);
			const resumed = await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: resumedManager,
				noTools: "all",
			});
			try {
				expect(resumed.session.messages.map((message) => message.role)).toEqual(["system"]);
				expect(
					resumedManager
						.getEntries()
						.filter((entry) => entry.type === "message" && entry.message.role === "system"),
				).toHaveLength(1);
			} finally {
				resumed.session.dispose();
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("appends a checkpoint when opening a transcript without prompt metadata", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-system-prompt-migration-"));
		try {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "existing", timestamp: 1 });
			const created = await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: SettingsManager.inMemory(),
				sessionManager,
				noTools: "all",
			});
			try {
				const roles = ["user", "system"];
				expect(created.session.messages.map((message) => message.role)).toEqual(roles);
				expect(sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual(roles);
			} finally {
				created.session.dispose();
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("diffs independently keyed XML sections without an update wrapper", () => {
		const previous = buildSystemPromptDefinition({ cwd: "/tmp", sections: { plan_mode: "Plan only." } });
		const current = buildSystemPromptDefinition({ cwd: "/tmp", sections: { plan_mode: "Implementation allowed." } });
		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: "<plan_mode>\nImplementation allowed.\n</plan_mode>",
		});
	});

	test("requires replacement when the exact prefix changes", () => {
		const previous = buildSystemPromptDefinition({ customPrompt: "You are A.", cwd: "/tmp" });
		const current = buildSystemPromptDefinition({ customPrompt: "You are B.", cwd: "/tmp" });
		expect(diffSystemPrompts(previous, current)).toEqual({ type: "replace" });
	});

	test("setActiveTools emits tool and prompt changes before the next request", async () => {
		const extension: ExtensionFactory = (pi) => {
			for (const name of ["first", "second"]) {
				pi.registerTool({
					name,
					label: name,
					description: `${name} description`,
					promptSnippet: `${name} prompt snippet`,
					promptGuidelines: [`Use ${name} carefully.`],
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
				});
			}
		};
		const harness = await createHarness({ extensionFactories: [extension], initialActiveToolNames: ["first"] });
		try {
			harness.setResponses([
				(providerContext) => {
					expect(providerContext.systemPrompt).toBeUndefined();
					expect(providerContext.tools).toBeUndefined();
					const initial = providerContext.messages[0];
					expect(initial?.role).toBe("system");
					if (initial?.role !== "system") throw new Error("expected initial system message");
					expect(initial.toolsAdded?.map((value) => value.name)).toContain("first");
					expect(initial.content).toContain("first prompt snippet");
					return fauxAssistantMessage("first");
				},
				(providerContext) => {
					expect(providerContext.systemPrompt).toBeUndefined();
					expect(providerContext.tools).toBeUndefined();
					expect(providerContext.messages[0]?.role).toBe("system");
					const update = providerContext.messages.filter((message) => message.role === "system").at(-1);
					expect(update?.toolsAdded?.map((value) => value.name)).toEqual(["second"]);
					expect(update?.toolsRemoved).toEqual([{ name: "first" }]);
					expect(update?.content).toContain("second prompt snippet");
					expect(update?.content).toContain("Use second carefully.");
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("first");
			harness.session.setActiveToolsByName(["second"]);
			await harness.session.prompt("second");
			const state = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "system_prompt")
				.at(-1);
			expect(state?.tools.map((value) => value.name)).toEqual(["second"]);
			expect(state?.prompt.type).toBe("structured");
		} finally {
			harness.cleanup();
		}
	});

	test("keeps tool declarations stable across a session JSON round-trip", async () => {
		const executableTool: AgentTool = {
			name: "plain",
			label: "Plain",
			description: "Plain tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const harness = await createHarness({ tools: [executableTool], initialActiveToolNames: ["plain"] });
		try {
			const state = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "system_prompt")
				.at(-1);
			if (!state) throw new Error("expected system prompt state");
			const declaration = state.tools[0];
			if (!declaration) throw new Error("expected tool declaration");
			expect(Object.hasOwn(declaration, "constrainedSampling")).toBe(false);

			const persistedTools = JSON.parse(JSON.stringify(state.tools)) as Tool[];
			const previous = {
				prompt: state.prompt,
				tools: new Map(persistedTools.map((persisted) => [persisted.name, persisted])),
				modelKey: state.modelKey,
			};
			const options = normalizeBuildSystemPromptOptions(
				harness.session.extensionRunner.createCommandContext().getSystemPromptOptions(),
			);

			expect(
				prepareModelContextUpdate({
					options,
					tools: new Map([[declaration.name, declaration]]),
					previous,
					capabilities: nativeCapabilities,
					modelKey: state.modelKey,
				}).message,
			).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	test("emits ordered tool deltas only when the transport can represent them", () => {
		const options = {
			cwd: "/tmp",
			selectedTools: [],
			toolSnippets: {},
			toolGuidelines: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			sections: {},
			contextFiles: [],
			skills: [],
		};
		const first = tool("first");
		const second = tool("second");
		const initial = prepareModelContextUpdate({
			options,
			tools: new Map([[first.name, first]]),
			capabilities: nativeCapabilities,
			modelKey: "model",
		});
		const addition = prepareModelContextUpdate({
			options,
			tools: new Map([
				[first.name, first],
				[second.name, second],
			]),
			previous: initial.state,
			capabilities: nativeCapabilities,
			modelKey: "model",
		});
		expect(addition.message).toMatchObject({ toolsAdded: [second] });
		expect(addition.message?.toolsRemoved).toBeUndefined();
		expect(addition.message?.content).not.toContain("complete current system prompt");

		const removal = prepareModelContextUpdate({
			options,
			tools: new Map([[second.name, second]]),
			previous: addition.state,
			capabilities: nativeCapabilities,
			modelKey: "model",
		});
		expect(removal.message).toMatchObject({ toolsRemoved: [{ name: "first" }] });
		expect(removal.message?.toolsAdded).toBeUndefined();

		const replacement = prepareModelContextUpdate({
			options,
			tools: new Map([[first.name, first]]),
			previous: addition.state,
			capabilities: noCapabilities,
			modelKey: "model",
		});
		expect(replacement.message).toMatchObject({ toolsRemoved: [{ name: "second" }] });
		expect(replacement.message?.toolsAdded).toBeUndefined();
		expect(replacement.message?.content).toContain("complete current system prompt");
	});
});
