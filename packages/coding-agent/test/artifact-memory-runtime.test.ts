import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AssistantMessage,
	Context,
	Message,
	SimpleStreamOptions,
} from "@kennyfrc/mu-ai";
import { agentLoop, getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunConfig, AgentTransport } from "../../agent/src/transports/types.js";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.js";
import { getArtifactMemoryProjectionPath } from "../src/memory/projection.js";
import { installArtifactMemoryRuntime } from "../src/memory/runtime.js";
import { normalizeArtifactMemoryWorkspaceRef, readArtifactMemoryEntries } from "../src/memory/store.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { writeTool } from "../src/tools/write.js";

function makeAssistantBase(model: ReturnType<typeof getModel>): Omit<AssistantMessage, "content" | "stopReason"> {
	if (!model) {
		throw new Error("Expected model to exist");
	}
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

class ArtifactMemoryRuntimeTransport implements AgentTransport {
	private callCount = 0;
	private readonly model = getModel("openai", "gpt-4o-mini");
	private readonly workspaceDir: string;

	constructor(workspaceDir: string) {
		this.workspaceDir = workspaceDir;
	}

	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const context: AgentContext = {
			systemPrompt: cfg.systemPrompt,
			messages,
			tools: cfg.tools,
		};
		const loopConfig: AgentLoopConfig = {
			model: cfg.model,
			reasoning: cfg.reasoning,
			interrupt: cfg.interrupt,
			toolResultTransformer: cfg.toolResultTransformer,
		};

		for await (const event of agentLoop(
			userMessage as never,
			context,
			loopConfig,
			signal,
			this.streamFn.bind(this),
		)) {
			yield event;
		}
	}

	private streamFn(
		_model: ReturnType<typeof getModel>,
		_context: Context,
		_options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		this.callCount += 1;
		const stream = new AssistantMessageEventStream();
		const model = this.model;
		if (!model) {
			throw new Error("Expected model to exist");
		}

		const toolCallByTurn: Record<number, AssistantMessage["content"]> = {
			1: [
				{
					type: "toolCall",
					id: "call-write",
					name: "write",
					arguments: {
						path: join(this.workspaceDir, "src", "artifact.ts"),
						content: "export const value = 'before';\n",
					},
				},
			],
			2: [
				{
					type: "toolCall",
					id: "call-edit",
					name: "edit",
					arguments: {
						path: join(this.workspaceDir, "src", "artifact.ts"),
						oldText: "before",
						newText: "after",
					},
				},
			],
			3: [
				{
					type: "toolCall",
					id: "call-apply-patch",
					name: "apply_patch",
					arguments: {
						input: [
							"*** Begin Patch",
							`*** Add File: ${join(this.workspaceDir, "src", "added.ts")}`,
							"+export const added = true;",
							"*** End Patch",
						].join("\n"),
					},
				},
			],
			4: [
				{
					type: "toolCall",
					id: "call-bash-artifact",
					name: "bash",
					arguments: {
						command: "mkdir -p dist && printf 'hello' > dist/output.txt",
					},
				},
			],
			5: [
				{
					type: "toolCall",
					id: "call-bash-no-artifact",
					name: "bash",
					arguments: {
						command: "printf 'noop'",
					},
				},
			],
		};

		const content = toolCallByTurn[this.callCount];
		const assistantMessage: AssistantMessage = content
			? {
					...makeAssistantBase(model),
					content,
					stopReason: "toolUse",
				}
			: {
					...makeAssistantBase(model),
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: assistantMessage });
			stream.push({
				type: "done",
				reason: assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop",
				message: assistantMessage,
			});
		});

		return stream;
	}
}

describe("artifact memory runtime", () => {
	let previousCwd: string;
	let workspaceDir: string;
	let memoryBaseDir: string;

	beforeEach(() => {
		previousCwd = process.cwd();
		workspaceDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-runtime-workspace-"));
		memoryBaseDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-runtime-base-"));
		execFileSync("git", ["init", "-q"], { cwd: workspaceDir });
		writeFileSync(join(workspaceDir, ".gitignore"), "", "utf8");
		process.chdir(workspaceDir);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(memoryBaseDir, { recursive: true, force: true });
	});

	it("appends memory entries only for write/edit/apply_patch and artifact-producing bash completions", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected model to exist");
		}

		const agent = new Agent({
			transport: new ArtifactMemoryRuntimeTransport(workspaceDir),
			initialState: {
				model,
				thinkingLevel: "off",
				tools: [writeTool, editTool, applyPatchTool, bashTool],
			},
		});

		installArtifactMemoryRuntime(agent, { baseDir: memoryBaseDir, cwd: workspaceDir });
		await agent.prompt("make artifacts");
		await new Promise((resolve) => setTimeout(resolve, 50));

		const entries = readArtifactMemoryEntries(memoryBaseDir);
		const normalizedArtifactPath = normalizeArtifactMemoryWorkspaceRef(join(workspaceDir, "src", "artifact.ts"));
		const normalizedBashArtifactPath = normalizeArtifactMemoryWorkspaceRef(join(workspaceDir, "dist", "output.txt"));
		expect(entries).toHaveLength(4);
		expect(entries.map((entry) => entry.sourceRefs?.[0])).toEqual([
			"tool:write",
			"tool:edit",
			"tool:apply_patch",
			"tool:bash",
		]);
		expect(entries.flatMap((entry) => entry.artifacts ?? [])).toContain(normalizedArtifactPath);
		expect(entries.flatMap((entry) => entry.artifacts ?? [])).toContain(normalizedBashArtifactPath);
		expect(entries.flatMap((entry) => entry.artifacts ?? [])).not.toContain("printf 'noop'");

		const projectionPath = getArtifactMemoryProjectionPath(workspaceDir, memoryBaseDir);
		expect(existsSync(projectionPath)).toBe(true);
		const projectionText = readFileSync(projectionPath, "utf8");
		expect(projectionText).toContain("artifact.ts");
		expect(projectionText).toContain("(no output)");
	});
});
