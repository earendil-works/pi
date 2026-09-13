import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type TranscriptCapabilities } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPromptPieces, diffSystemPrompts } from "../src/core/system-prompt.ts";
import { prepareModelContextUpdate } from "../src/core/system-prompt-updates.ts";
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

	test("diffs independently keyed XML sections", () => {
		const previous = buildSystemPromptPieces({ cwd: "/tmp", sections: { plan_mode: "Plan only." } });
		const current = buildSystemPromptPieces({ cwd: "/tmp", sections: { plan_mode: "Implementation allowed." } });
		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: "The <plan_mode> system guidance has changed. The following supersedes the previous <plan_mode> system guidance:\n\n<plan_mode>\nImplementation allowed.\n</plan_mode>",
		});
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
			expect(state?.initialTools.map((value) => value.name)).toContain("first");
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
			promptTail: "",
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
		expect(addition).toMatchObject({ type: "incremental", toolsAdded: [second], toolsRemoved: [] });
		if (addition.type !== "incremental") throw new Error("expected incremental update");

		const removal = prepareModelContextUpdate({
			options,
			tools: new Map([[second.name, second]]),
			previous: addition.state,
			capabilities: nativeCapabilities,
			modelKey: "model",
		});
		expect(removal).toMatchObject({ type: "incremental", toolsAdded: [], toolsRemoved: [{ name: "first" }] });

		const replacement = prepareModelContextUpdate({
			options,
			tools: new Map([[first.name, first]]),
			previous: addition.state,
			capabilities: noCapabilities,
			modelKey: "model",
		});
		expect(replacement).toMatchObject({
			type: "replacement",
			toolsAdded: [],
			toolsRemoved: [{ name: "second" }],
		});
		if (replacement.type !== "replacement") throw new Error("expected replacement");
		expect(replacement.promptText).toContain("complete current system prompt");
	});
});
