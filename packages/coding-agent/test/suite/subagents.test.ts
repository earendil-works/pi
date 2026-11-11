import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { getOutputArtifacts } from "../../src/core/output-artifacts.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { discoverAgentDefinitions } from "../../src/core/subagents/definitions.ts";
import { SubagentManager } from "../../src/core/subagents/manager.ts";
import type { SubagentHistoryPage } from "../../src/core/subagents/state.ts";
import { createSubagentExtension } from "../../src/extensions/subagents/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const fixtures: Array<{ directory: string; harness: Harness; reader: SubagentManager }> = [];
const factoryFailures: unknown[] = [];

async function fixture(options: HarnessOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-agents-"));
	const parent = SessionManager.create(directory, join(directory, "sessions"));
	parent.appendMessage({ role: "user", content: "PARENT_PRIVATE_CONTEXT", timestamp: 1 });
	parent.appendMessage(fauxAssistantMessage("Parent setup response"));
	const harness = await createHarness({
		...options,
		sessionManager: parent,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...options.settings },
		extensionFactories: [createSubagentExtension(directory), ...(options.extensionFactories ?? [])],
	});
	harness.session.agent.sessionId = parent.getSessionId();
	const reader = new SubagentManager({
		parent,
		cwd: harness.tempDir,
		agentDir: directory,
		modelRuntime: harness.session.modelRuntime,
		getSettings: () => harness.settingsManager.getSettings(),
		getModel: () => harness.session.model,
		getThinkingLevel: () => harness.session.agent.state.thinkingLevel,
		getAllowedTools: () => harness.session.getActiveToolNames(),
		getSystemPrompt: () => harness.session.agent.state.systemPrompt,
	});
	fixtures.push({ directory, harness, reader });
	return { directory, parent, harness, reader };
}

afterEach(async () => {
	for (const { directory, harness, reader } of fixtures.splice(0)) {
		await Promise.all([
			harness.session.abort(),
			reader.close(),
			harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
		]);
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
	expect(factoryFailures.splice(0)).toEqual([]);
});

function delegate(args: Record<string, unknown>) {
	return fauxAssistantMessage(
		{ type: "toolCall", id: "delegate-call", name: "subagent", arguments: { action: "start", ...args } },
		{ stopReason: "toolUse" },
	);
}

function queueFactory(harness: Harness, factory: FauxResponseFactory) {
	const checked: FauxResponseFactory = async (context, options, state, model) => {
		if (options?.sessionId?.startsWith("label:")) return fauxAssistantMessage("Inspect delegated task");
		try {
			return await factory(context, options, state, model);
		} catch (error) {
			factoryFailures.push(error);
			throw error;
		}
	};
	harness.setResponses(Array.from({ length: 12 }, () => checked));
}

function retainedToolText(harness: Harness, message: unknown): string {
	const text = getMessageText(message);
	const uri = /^\[Full captured output: (artifact:\/\/(?:temporary\/)?[a-f0-9]{64}\/[a-f0-9-]{36})\./.exec(text)?.[1];
	return uri ? readFileSync(getOutputArtifacts(harness.sessionManager)!.resolve(uri), "utf8") : text;
}

describe("native sub-agent controls", () => {
	it("runs local tools in the child's cwd without inheriting parent extension closures or leaking its trace", async () => {
		let parentOnlyCalls = 0;
		const parentExtension: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "parent_only",
				label: "Parent only",
				description: "Parent-owned tool",
				parameters: Type.Object({}),
				async execute() {
					parentOnlyCalls++;
					return { content: [{ type: "text", text: "PARENT CONTAMINATION" }], details: {} };
				},
			});
		};
		const { parent, harness, reader } = await fixture({ extensionFactories: [parentExtension] });
		writeFileSync(join(harness.tempDir, "evidence.txt"), "PRIVATE_CHILD_TOOL_LOG: parser boundary evidence");
		let mainCalls = 0;
		let childCalls = 0;
		queueFactory(harness, (context, options) => {
			if (options?.sessionId === parent.getSessionId()) {
				if (++mainCalls === 1) return delegate({ task: "Read evidence.txt and return only a concise finding" });
				expect(JSON.stringify(context)).not.toContain("PRIVATE_CHILD_TOOL_LOG");
				expect(JSON.stringify(context)).not.toContain("CHILD_PRIVATE_REASONING");
				return fauxAssistantMessage("Parent received the concise finding");
			}
			if (++childCalls === 1) {
				expect(JSON.stringify(context)).not.toContain("PARENT_PRIVATE_CONTEXT");
				return fauxAssistantMessage(
					[
						{ type: "thinking", thinking: "CHILD_PRIVATE_REASONING" },
						{ type: "toolCall", id: "child-read", name: "read", arguments: { path: "evidence.txt" } },
						{ type: "toolCall", id: "child-parent-tool", name: "parent_only", arguments: {} },
					],
					{ stopReason: "toolUse" },
				);
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			expect(getMessageText(results.find((message) => message.toolCallId === "child-read"))).toContain(
				"PRIVATE_CHILD_TOOL_LOG",
			);
			expect(results.find((message) => message.toolCallId === "child-parent-tool")?.isError).toBe(true);
			return fauxAssistantMessage("Concise finding: the parser boundary is covered");
		});
		await harness.session.prompt("Delegate the local investigation");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain(
			"Concise finding: the parser boundary is covered",
		);
		expect(parentOnlyCalls).toBe(0);
		const child = reader.list()[0];
		const childLog = readFileSync(child.historyPath!, "utf8");
		expect(childLog).toContain("PRIVATE_CHILD_TOOL_LOG");
		expect(childLog).toContain("CHILD_PRIVATE_REASONING");
		const mainLog = readFileSync(parent.getSessionFile()!, "utf8");
		expect(mainLog).not.toContain("PRIVATE_CHILD_TOOL_LOG");
		expect(mainLog).not.toContain("CHILD_PRIVATE_REASONING");
		expect(mainLog).not.toContain("child-parent-tool");
	});

	it("inherits active conversation and original image attachments only when a snapshot is requested", async () => {
		const { parent, harness } = await fixture({ models: [{ id: "vision", input: ["text", "image"] }] });
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII=",
		};
		parent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Snapshot-specific private background" }, image],
			timestamp: 2,
		});
		parent.appendMessage(fauxAssistantMessage("Image context acknowledged"));
		let mainCalls = 0;
		queueFactory(harness, (context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({
							task: "Use the frozen background",
							contextMode: "snapshot",
							context: "Explicit additional requirement",
						})
					: fauxAssistantMessage("Snapshot result received");
			expect(JSON.stringify(context)).toContain("Snapshot-specific private background");
			expect(JSON.stringify(context)).toContain("Explicit additional requirement");
			const images = context.messages.flatMap((message) =>
				message.role !== "assistant" && typeof message.content !== "string"
					? message.content.filter((content) => content.type === "image")
					: [],
			);
			expect(images).toContainEqual(image);
			return fauxAssistantMessage("Original snapshot text and image were available");
		});
		await harness.session.prompt("Delegate with a snapshot");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain(
			"Original snapshot text and image were available",
		);
	});

	it("honors configured role tools and model without enabling recursive native delegation", async () => {
		const { directory, parent, harness, reader } = await fixture({
			models: [{ id: "main" }, { id: "review", reasoning: true }],
		});
		mkdirSync(join(directory, "agents"));
		writeFileSync(
			join(directory, "agents", "auditor.md"),
			`---\nname: auditor\ndescription: Review without writes\ntools: read\nmodel: ${harness.getModel().provider}/review\nthinkingLevel: high\n---\nCheck the assigned boundary without changing files.\n`,
		);
		const protectedFile = join(harness.tempDir, "protected.txt");
		writeFileSync(protectedFile, "Original shared-tree contents");
		let mainCalls = 0;
		let childCalls = 0;
		queueFactory(harness, (context, options, _state, model) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ agent: "auditor", task: "Review protected.txt" })
					: fauxAssistantMessage("Read-only review received");
			expect(model.id).toBe("review");
			if (++childCalls === 1)
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "forbidden-write",
							name: "write",
							arguments: { path: "protected.txt", content: "Overwritten" },
						},
						{
							type: "toolCall",
							id: "recursive-child",
							name: "subagent",
							arguments: { action: "start", task: "Nested task" },
						},
					],
					{ stopReason: "toolUse" },
				);
			const results = context.messages.filter((message) => message.role === "toolResult");
			expect(results.find((message) => message.toolCallId === "forbidden-write")?.isError).toBe(true);
			expect(results.find((message) => message.toolCallId === "recursive-child")?.isError).toBe(true);
			return fauxAssistantMessage("Read-only boundary held");
		});
		await harness.session.prompt("Use the configured auditor");
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain("Read-only boundary held");
		expect(readFileSync(protectedFile, "utf8")).toBe("Original shared-tree contents");
		expect(reader.list()[0].thinkingLevel).toBe("high");
	});

	it("requires approval before executing a repository-controlled role in an untrusted project", async () => {
		const { harness, reader } = await fixture();
		harness.settingsManager.setProjectTrusted(false);
		mkdirSync(join(harness.tempDir, CONFIG_DIR_NAME, "agents"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, CONFIG_DIR_NAME, "agents", "repo-worker.md"),
			"---\nname: repo-worker\ndescription: Repository controlled worker\ntools: write\n---\nChange the shared working tree.\n",
		);
		harness.setResponses([
			delegate({ agent: "repo-worker", task: "Execute a repository-defined role" }),
			fauxAssistantMessage("Approval was required"),
		]);
		await harness.session.prompt("Try the untrusted project role");
		expect(getToolResult(harness, "subagent").isError).toBe(true);
		expect(reader.list()).toEqual([]);
	});

	it.each(["completed", "failed"] as const)(
		"delivers one bounded async %s result without starting an idle parent request",
		async (outcome) => {
			const { parent, harness, reader } = await fixture();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<void>();
			const unsubscribe = harness.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "subagent-result"
				)
					delivered.resolve();
			});
			let mainCalls = 0;
			queueFactory(harness, async (_context, options) => {
				if (options?.sessionId === parent.getSessionId())
					return ++mainCalls === 1
						? delegate({ task: "Produce the asynchronous finding", async: true })
						: fauxAssistantMessage("The background child is still running");
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				const text = `FINAL_ASYNC_FINDING\n${"Long child evidence. ".repeat(6000)}`;
				return outcome === "completed"
					? fauxAssistantMessage(text)
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
			});
			const run = harness.session.prompt("Launch a background child");
			await started.promise;
			await run;
			const child = reader.list()[0];
			expect(child.status).toBe("running");
			expect(getMessageText(getToolResult(harness, "subagent"))).not.toContain("FINAL_ASYNC_FINDING");
			release.resolve();
			await delivered.promise;
			unsubscribe();
			expect(mainCalls).toBe(2);
			const notices = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			);
			expect(notices).toHaveLength(1);
			expect(getMessageText(notices[0])).toContain("FINAL_ASYNC_FINDING");
			expect(Buffer.byteLength(getMessageText(notices[0]))).toBeLessThan(53000);
			expect(readFileSync(child.historyPath!, "utf8")).toContain("Long child evidence. ".repeat(6000));
			if (outcome === "failed")
				expect(reader.history(child.id, 0, Number.MAX_SAFE_INTEGER).text).toContain(
					"Long child evidence. ".repeat(6000),
				);
		},
	);

	it("holds async results off unrelated branches and delivers them after returning to the launch branch", async () => {
		const { parent, harness, reader } = await fixture();
		const beforeLaunch = parent.getLeafId()!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "subagent-result"
			)
				delivered.resolve();
		});
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ task: "Finish on the originating branch", async: true })
					: fauxAssistantMessage("Child launched on this branch");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("BRANCH_SCOPED_RESULT");
		});
		const run = harness.session.prompt("Launch a branch-scoped child");
		await started.promise;
		await run;
		const launchLeaf = parent.getLeafId()!;
		const child = reader.list()[0];
		await harness.session.navigateTree(beforeLaunch, { summarize: false });
		release.resolve();
		await vi.waitFor(() => expect(reader.inspect(child.id).status).toBe("completed"));
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toBe(false);
		await harness.session.navigateTree(launchLeaf, { summarize: false });
		await delivered.promise;
		unsubscribe();
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "subagent-result",
			),
		).toHaveLength(1);
		expect(mainCalls).toBe(2);
	});
	it("paginates the actual rows returned under the byte cap without losing queued children", async () => {
		const { directory, parent, harness, reader } = await fixture({ settings: { subagents: { maxConcurrent: 1 } } });
		const role = discoverAgentDefinitions(harness.tempDir, directory).agents.find(
			(agent) => agent.name === "worker",
		)!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: string[] = [];
		let mainCalls = 0;
		queueFactory(harness, async (context, options) => {
			if (options?.sessionId !== parent.getSessionId()) {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("Stopped metadata-list fixture");
			}
			let skip = 0;
			if (++mainCalls > 1) {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "subagent",
				);
				const page = JSON.parse(retainedToolText(harness, result)) as {
					agents: Array<{ id: string }>;
					total: number;
					nextSkip?: number;
				};
				expect(page.total).toBe(120);
				seen.push(...page.agents.map((agent) => agent.id));
				if (page.nextSkip === undefined) return fauxAssistantMessage("All queued children listed");
				expect(page.nextSkip).toBe(seen.length);
				skip = page.nextSkip;
			}
			return fauxAssistantMessage(
				{
					type: "toolCall",
					id: `list-${mainCalls}`,
					name: "subagent",
					arguments: { action: "list", limit: 100, skip },
				},
				{ stopReason: "toolUse" },
			);
		});
		const children = Array.from({ length: 120 }, (_, index) => reader.start(role, `Queued task ${index}`));
		await started.promise;
		await harness.session.prompt("List the queued children through every page");
		expect(seen).toHaveLength(120);
		expect(new Set(seen)).toEqual(new Set(children.map((child) => child.id)));
	});

	it("returns parseable history pages and actionable offsets even for heavily escaped tool text", async () => {
		const { parent, harness, reader } = await fixture();
		let mainCalls = 0;
		let offset = 0;
		let retrieved = "";
		queueFactory(harness, (context, options) => {
			if (options?.sessionId !== parent.getSessionId())
				return fauxAssistantMessage(`${"\0".repeat(16000)}END_OF_CHILD_RESPONSE`);
			if (++mainCalls === 1) return delegate({ task: "Return the unusual original evidence" });
			const child = reader.list()[0];
			if (mainCalls === 2)
				return fauxAssistantMessage(
					{
						type: "toolCall",
						id: "history-first",
						name: "subagent",
						arguments: { action: "history", id: child.id },
					},
					{ stopReason: "toolUse" },
				);
			const result = context.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "subagent",
			);
			const page = JSON.parse(retainedToolText(harness, result)) as SubagentHistoryPage;
			expect(page.offset).toBe(offset);
			retrieved += page.text;
			const nextOffset = page.nextOffset;
			if (nextOffset !== undefined) {
				expect(nextOffset).toBeGreaterThan(offset);
				offset = nextOffset;
				return fauxAssistantMessage(
					{
						type: "toolCall",
						id: `history-${mainCalls}`,
						name: "subagent",
						arguments: { action: "history", id: child.id, offset },
					},
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Original history can be paged without gaps");
		});
		await harness.session.prompt("Inspect the child's original evidence in pages");
		expect(retrieved).toContain(`${"\0".repeat(16000)}END_OF_CHILD_RESPONSE`);
	});

	it("does not deadlock group pause behind an already-running synchronous delegation tool", async () => {
		const { parent, harness, reader } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let mainCalls = 0;
		queueFactory(harness, async (_context, options) => {
			if (options?.sessionId === parent.getSessionId())
				return ++mainCalls === 1
					? delegate({ task: "Finish the synchronous child" })
					: fauxAssistantMessage("Parent continued once");
			started.resolve();
			options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return fauxAssistantMessage("Synchronous child completed");
		});
		const run = harness.session.prompt("Delegate then pause safely");
		await started.promise;
		const pausing = harness.session.recovery.pause();
		release.resolve();
		await pausing;
		expect(reader.list().map((agent) => agent.status)).toEqual(["completed"]);
		expect(mainCalls).toBe(1);
		harness.session.recovery.resume();
		await run;
		expect(mainCalls).toBe(2);
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain("Synchronous child completed");
	});
});
