import {
	AgentHarness,
	type AgentHarnessOptions,
	type ExecutionError,
	type HarnessTool,
	InMemorySessionStorage,
	type Result,
	Session,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import {
	buildCodingAgentHarnessSystemPrompt,
	type CodingAgentHarnessTool,
	createCodingAgentHarness,
} from "../../src/server/create-harness.ts";

class CapturingExecutionEnv extends NodeExecutionEnv {
	executionOverrides: Record<string, string> | undefined;

	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.executionOverrides = options?.env;
		return super.exec(command, options);
	}
}

async function resolveSystemPrompt(systemPrompt: AgentHarnessOptions["systemPrompt"]): Promise<string> {
	if (typeof systemPrompt === "string") return systemPrompt;
	if (systemPrompt === undefined) throw new Error("Expected a system prompt callback");
	return systemPrompt();
}

function createPromptTool(name: string, promptSnippet?: string, promptGuidelines?: string[]): CodingAgentHarnessTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		promptSnippet,
		promptGuidelines,
	};
}

const defaultPromptTools = [
	createPromptTool("read", "Read file contents", ["Use read to examine files instead of cat or sed."]),
	createPromptTool("bash", "Execute bash commands (ls, grep, find, etc.)", [
		"You can inspect PI_* environment variables for current model and session details.",
	]),
	createPromptTool("edit", "Edit files", ["Edit carefully."]),
	createPromptTool("write", "Create or overwrite files", ["Use write only for new files or complete rewrites."]),
];

describe("coding-agent Harness construction", () => {
	test("adds coding-agent policy to explicit Harness options", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "harness-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			streamOptions: { maxTokens: 123 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
			steeringMode: "all",
			followUpMode: "all",
		});
		try {
			expect(created.suspended).toEqual([]);
			expect(await created.harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
			expect(await created.harness.getStreamOptions()).toEqual({ maxTokens: 123 });
			expect(await created.harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });
			expect(await created.harness.getSteeringMode()).toBe("all");
			expect(await created.harness.getFollowUpMode()).toBe("all");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("preserves coding-agent prompt snippets and guideline order", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["read", "bash", "edit", "write"],
		});
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
		expect(prompt).toContain("Use read to examine files instead of cat or sed.");
		expect(prompt).toContain("You can inspect PI_* environment variables for current model and session details.");
		expect(prompt.indexOf("Use read to examine files")).toBeLessThan(
			prompt.indexOf("You can inspect PI_* environment variables"),
		);
	});

	test("preserves caller-supplied tools and activation", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "custom-harness-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const customTool: HarnessTool = {
			name: "inspect",
			label: "inspect",
			description: "Inspect the configured service",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		};
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			tools: [customTool],
			activeToolNames: [],
			systemPrompt: "Server-owned prompt",
		});
		try {
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual(["inspect"]);
			expect(await created.harness.getActiveTools()).toEqual([]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("sets the optional session file in the default bash tool environment", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-file-harness", createdAt: 1 }));
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			sessionFile: "/sessions/current.jsonl",
		});
		try {
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s' "$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toEqual({
				PI_SESSION_ID: "session-file-harness",
				PI_SESSION_FILE: "/sessions/current.jsonl",
				PI_PROVIDER: "google",
				PI_MODEL: "gemini-2.5-flash",
				PI_REASONING_LEVEL: "high",
			});
			expect(result.content).toEqual([
				{
					type: "text",
					text: "session-file-harness|/sessions/current.jsonl|google|gemini-2.5-flash|high|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("keeps bash PI model variables synchronized with Harness state", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "dynamic-bash-session", createdAt: 1 }));
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
		});
		try {
			await created.harness.setModel(getModel("anthropic", "claude-sonnet-4-5"));
			await created.harness.setThinkingLevel("low");
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s:%s' "\${PI_SESSION_FILE+x}" "$PI_SESSION_ID|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toEqual({
				PI_SESSION_ID: "dynamic-bash-session",
				PI_SESSION_FILE: "",
				PI_PROVIDER: "anthropic",
				PI_MODEL: "claude-sonnet-4-5",
				PI_REASONING_LEVEL: "low",
			});
			expect(Object.hasOwn(env.executionOverrides ?? {}, "PI_SESSION_FILE")).toBe(true);
			expect(env.executionOverrides?.PI_SESSION_FILE).toBe("");
			expect(result.content).toEqual([
				{
					type: "text",
					text: "x:dynamic-bash-session|anthropic|claude-sonnet-4-5|low|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("builds each default system prompt from current Harness tool metadata", async () => {
		const originalCreate = AgentHarness.create.bind(AgentHarness);
		let configuredSystemPrompt: AgentHarnessOptions["systemPrompt"];
		const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async (options) => {
			configuredSystemPrompt = options.systemPrompt;
			return originalCreate(options);
		});
		const session = new Session(new InMemorySessionStorage({ id: "dynamic-prompt-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		try {
			const created = await createCodingAgentHarness({
				session,
				models: createModels(),
				model: getModel("google", "gemini-2.5-flash"),
				env,
			});
			createSpy.mockRestore();
			try {
				const initialPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(initialPrompt).toContain("- read: Read file contents");
				expect(initialPrompt).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
				expect(initialPrompt).toContain("- edit: Make precise file edits with exact text replacement");
				expect(initialPrompt).toContain("- write: Create or overwrite files");

				await created.harness.setActiveTools(["write"]);
				const writePrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(writePrompt).toContain("- write: Create or overwrite files");
				expect(writePrompt).not.toContain("- read:");
				expect(writePrompt).not.toContain("- bash:");

				const read = (await created.harness.getTools()).find((tool) => tool.name === "read");
				if (!read) throw new Error("Expected the default read tool");
				await created.harness.setTools([read]);
				const readPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(readPrompt).toContain("- read: Read file contents");
				expect(readPrompt).not.toContain("- write:");

				const inspectTool: CodingAgentHarnessTool = {
					name: "inspect",
					label: "inspect",
					description: "Inspect the configured service",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
					promptSnippet: "  Inspect\nthe   configured service  ",
					promptGuidelines: ["Use inspect for service diagnostics."],
				};
				await created.harness.setTools([inspectTool]);
				const inspectPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(inspectPrompt).toContain("- inspect: Inspect the configured service");
				expect(inspectPrompt).toContain("Use inspect for service diagnostics.");
			} finally {
				await created.harness.close();
				await env.cleanup();
			}
		} finally {
			createSpy.mockRestore();
		}
	});

	test("omits active custom tools without prompt metadata from the textual tools section", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: [createPromptTool("hidden")],
			activeToolNames: ["hidden"],
		});

		expect(prompt).toContain("Available tools:\n(none)");
		expect(prompt).not.toContain("- hidden:");
		expect(prompt).not.toContain("hidden description");
	});

	test.each([
		[
			"bash",
			"Execute bash commands (ls, grep, find, etc.)",
			"You can inspect PI_* environment variables for current model and session details.",
		],
		["read", "Read file contents", "Use read to examine files instead of cat or sed."],
		[
			"edit",
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			"Use edit for precise changes (edits[].oldText must match exactly)",
		],
		["write", "Create or overwrite files", "Use write only for new files or complete rewrites."],
	] as const)(
		"does not infer prompt metadata for a caller-supplied %s replacement",
		(name, builtInSnippet, builtInGuideline) => {
			const prompt = buildCodingAgentHarnessSystemPrompt({
				cwd: "/workspace",
				tools: [createPromptTool(name)],
				activeToolNames: [name],
			});

			expect(prompt).toContain("Available tools:\n(none)");
			expect(prompt).not.toContain(builtInSnippet);
			expect(prompt).not.toContain(builtInGuideline);
		},
	);

	test("builds the default prompt from active tools and resolved prompt resources", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["write", "read"],
			systemPromptOptions: {
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "Follow project policy." }],
				skills: [
					{
						name: "review",
						description: "Review server changes",
						filePath: "/skills/review/SKILL.md",
						baseDir: "/skills/review",
						sourceInfo: {
							path: "/skills/review/SKILL.md",
							source: "test",
							scope: "temporary",
							origin: "top-level",
						},
						disableModelInvocation: false,
					},
				],
			},
		});

		expect(prompt).toContain("- write: Create or overwrite files");
		expect(prompt).toContain("- read: Read file contents");
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("You can inspect PI_* environment variables");
		expect(prompt).toContain('<project_instructions path="/workspace/AGENTS.md">');
		expect(prompt).toContain("<name>review</name>");
		expect(prompt.indexOf("Use write only for new files or complete rewrites.")).toBeLessThan(
			prompt.indexOf("Use read to examine files instead of cat or sed."),
		);
	});
});
