import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, ExtensionAPI, InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const processImage = vi.hoisted(() =>
	vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
		ok: true as const,
		data: Buffer.from("normalized").toString("base64"),
		mimeType,
		hints: [],
	})),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		processImage.mockClear();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[3]?.role).toBe("toolResult");
		expect(harness.session.messages[4]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9631
	it("uses the model selected by before_agent_start for image normalization", async () => {
		let strictModel: Model<string> | undefined;
		const harness = await createHarness({
			models: [{ id: "wide" }, { id: "strict" }],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!strictModel) throw new Error("Expected strict model");
						await pi.setModel(strictModel);
					});
				},
			],
		});
		harnesses.push(harness);
		strictModel = harness.getModel("strict");
		if (!strictModel) throw new Error("Expected strict model");
		const resizeOptions = { maxWidth: 1000, maxHeight: 1000, maxBytes: 500000, jpegQuality: 70 };
		strictModel.inputLimits = { images: { resize: resizeOptions } };
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("inspect", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(harness.session.model?.id).toBe("strict");
		expect(processImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", {
			autoResizeImages: true,
			resizeOptions,
		});
		const userMessage = harness.session.messages.find((message) => message.role === "user");
		expect(userMessage?.content).toContainEqual({
			type: "image",
			data: Buffer.from("normalized").toString("base64"),
			mimeType: "image/png",
		});
	});

	it("expands skill commands before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("sendUserMessage can opt into prompt template expansion", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("extension sendUserMessage can opt into extension command dispatch", async () => {
		let extensionApi: ExtensionAPI | undefined;
		let resolveCommandRun: (args: string) => void = () => {};
		const commandRun = new Promise<string>((resolve) => {
			resolveCommandRun = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							resolveCommandRun(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		expect(extensionApi).toBeDefined();

		extensionApi?.sendUserMessage("/testcmd hello world", { expandPromptTemplates: true });

		await expect(commandRun).resolves.toBe("hello world");
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("from extension");
	});

	it("does not report streamingBehavior to input handlers while idle", async () => {
		const inputEvents: InputEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("idle", { streamingBehavior: "followUp" });

		expect(inputEvents).toHaveLength(1);
		expect(inputEvents[0]?.streamingBehavior).toBeUndefined();
	});

	it("reports streamingBehavior to input handlers while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const inputEvents: InputEvent[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("queued", { streamingBehavior: "followUp" });

		expect(inputEvents.map((event) => event.streamingBehavior)).toEqual([undefined, "followUp"]);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during manual compaction", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const compactPromise = harness.session.compact();
		await compactionStarted;

		try {
			await expect(harness.session.prompt("third")).rejects.toThrow(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		} finally {
			releaseCompaction();
			await compactPromise;
		}
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});

	// Issue #10267, #5581: a run started by sendMessage(..., { triggerTurn: true }) skipped
	// before_agent_start, so its second request patched away the sections handlers had added.
	describe("runs started by a custom message", () => {
		it("keeps the same system prompt for every request of the run", async () => {
			const events: BeforeAgentStartEvent[] = [];
			const noopTool: AgentTool = {
				name: "noop",
				label: "Noop",
				description: "Does nothing",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			};
			const harness = await createHarness({
				tools: [noopTool],
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (event) => {
							events.push(event);
							event.systemPromptOptions.sections.extension_rules = "Answer in one word.";
						});
					},
				],
			});
			harnesses.push(harness);
			const prompts: string[] = [];
			const record = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return response;
			};
			harness.setResponses([
				record(fauxAssistantMessage("hi")),
				record(fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" })),
				record(fauxAssistantMessage("done")),
			]);

			await harness.session.prompt("hello");
			await harness.session.sendCustomMessage(
				{ customType: "task-done", content: "background task finished", display: true },
				{ triggerTurn: true },
			);

			expect(prompts).toHaveLength(3);
			expect(prompts[0]).toContain("Answer in one word.");
			expect(new Set(prompts).size).toBe(1);
			expect(events.map((event) => event.messageType)).toEqual(["user", "custom"]);
			const customEvent = events[1];
			expect(customEvent.messageType === "custom" && customEvent.message.customType).toBe("task-done");
		});

		it("queues a custom message sent while before_agent_start runs into the starting run", async () => {
			let releaseHandler: () => void = () => {};
			const handlerStarted = Promise.withResolvers<void>();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async (event) => {
							if (event.messageType !== "custom" || event.message.customType !== "first") return;
							handlerStarted.resolve();
							await new Promise<void>((resolve) => {
								releaseHandler = resolve;
							});
						});
					},
				],
			});
			harnesses.push(harness);
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(context) => {
					requests.push(context);
					return fauxAssistantMessage("handled both");
				},
			]);

			const first = harness.session.sendCustomMessage(
				{ customType: "first", content: "task one finished", display: true },
				{ triggerTurn: true },
			);
			await handlerStarted.promise;
			expect(harness.session.isIdle).toBe(false);
			const second = harness.session.sendCustomMessage(
				{ customType: "second", content: "task two finished", display: true },
				{ triggerTurn: true },
			);
			releaseHandler();
			await Promise.all([first, second]);

			expect(requests).toHaveLength(1);
			const texts = requests[0].messages.flatMap((message) =>
				message.role === "user" && typeof message.content !== "string"
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
			);
			expect(texts).toEqual(["task one finished", "task two finished"]);
		});

		it("includes a custom message sent without triggerTurn while the run starts in its first request", async () => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => {
							pi.sendMessage(
								{ customType: "note", content: "context from handler", display: true },
								{ triggerTurn: false },
							);
						});
					},
				],
			});
			harnesses.push(harness);
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(context) => {
					requests.push(context);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("hello");

			expect(requests).toHaveLength(1);
			expect(JSON.stringify(requests[0].messages)).toContain("context from handler");
		});

		it("aborts a run when abort is requested while before_agent_start runs", async () => {
			let releaseHandler: () => void = () => {};
			const handlerStarted = Promise.withResolvers<void>();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							handlerStarted.resolve();
							await new Promise<void>((resolve) => {
								releaseHandler = resolve;
							});
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("should not complete")]);

			const run = harness.session.sendCustomMessage(
				{ customType: "task-done", content: "background task finished", display: true },
				{ triggerTurn: true },
			);
			await handlerStarted.promise;
			const aborted = harness.session.abort();
			releaseHandler();
			await Promise.all([run, aborted]);

			const last = harness.session.messages.at(-1);
			expect(last?.role).toBe("assistant");
			expect(last?.role === "assistant" && last.stopReason).toBe("aborted");
			expect(harness.session.isIdle).toBe(true);
		});
	});
});
