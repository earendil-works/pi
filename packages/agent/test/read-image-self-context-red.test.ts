import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentTool,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	UserMessage,
} from "@kennyfrc/mu-ai";
import { agentLoop, getModel } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.js";
import { Agent } from "../src/agent.js";
import type { AgentRunConfig, AgentTransport } from "../src/transports/types.js";

const readImageSchema = Type.Object({
	path: Type.String(),
	objective: Type.String(),
	mode: Type.Literal("self"),
});

type ReadImageParams = Static<typeof readImageSchema>;

interface ReadImageSelfDetails {
	mode: "self";
	objective: string;
	images: Array<{
		role: "primary";
		source: string;
		mimeType: string;
		base64: string;
	}>;
}

function makeAssistantBase(model: Model<any>): Omit<AssistantMessage, "content" | "stopReason"> {
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

function getTextContent(message: Message): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function hasImageContent(message: Message): boolean {
	if (message.role !== "user") return false;
	return (
		Array.isArray(message.content) && message.content.some((block): block is ImageContent => block.type === "image")
	);
}

function getAssistantText(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	const block = message.content.find((item): item is TextContent => item.type === "text");
	return block?.text ?? "";
}

const readImageSelfTool: AgentTool<typeof readImageSchema, ReadImageSelfDetails> = {
	name: "read_image",
	label: "read_image",
	description: "Request same-context image reading by the current model",
	parameters: readImageSchema,
	execute: async (_toolCallId: string, params: ReadImageParams) => ({
		content: [
			{
				type: "text",
				text: `Queued image for same-context reading: ${params.objective}`,
			},
		],
		details: {
			mode: "self",
			objective: params.objective,
			images: [
				{
					role: "primary",
					source: params.path,
					mimeType: "image/png",
					base64: "aGVsbG8=",
				},
			],
		},
	}),
};

class ReadImageSelfContextTransport implements AgentTransport {
	private callCount = 0;
	private readonly firstTurnToolCalls: Array<{ id: string; objective: string }>;

	constructor(firstTurnToolCalls: Array<{ id: string; objective: string }>) {
		this.firstTurnToolCalls = firstTurnToolCalls;
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
			userMessage as UserMessage,
			context,
			loopConfig,
			signal,
			this.streamFn.bind(this),
		)) {
			yield event;
		}
	}

	private streamFn(model: Model<any>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
		this.callCount += 1;
		const stream = new AssistantMessageEventStream();
		const base = makeAssistantBase(model);

		const assistantMessage: AssistantMessage =
			this.callCount === 1
				? {
						...base,
						content: this.firstTurnToolCalls.map(({ id, objective }) => ({
							type: "toolCall" as const,
							id,
							name: "read_image",
							arguments: {
								path: `${objective}.png`,
								objective,
								mode: "self" as const,
							},
						})),
						stopReason: "toolUse",
					}
				: {
						...base,
						content: [
							{
								type: "text",
								text: this.evaluateContinuationContext(context),
							},
						],
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

	private evaluateContinuationContext(context: Context): string {
		const promptStillPresent = context.messages.some(
			(message) => message.role === "user" && getTextContent(message).includes("Initial prompt"),
		);

		const toolResultPresent = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "read_image",
		);

		const injectedUserMessages = context.messages.filter(
			(message) => message.role === "user" && hasImageContent(message),
		);
		const injectedText = injectedUserMessages.map(getTextContent).join("\n---\n");
		const injectedImageCount = injectedUserMessages.filter(hasImageContent).length;

		const sawOrderedObjectives = this.firstTurnToolCalls.every(({ objective }, index) => {
			const currentIndex = injectedText.indexOf(objective);
			if (currentIndex === -1) return false;
			if (index === 0) return true;
			const previousObjective = this.firstTurnToolCalls[index - 1]?.objective;
			if (!previousObjective) return true;
			return injectedText.indexOf(previousObjective) < currentIndex;
		});

		return promptStillPresent &&
			toolResultPresent &&
			injectedImageCount >= this.firstTurnToolCalls.length &&
			sawOrderedObjectives
			? this.firstTurnToolCalls.length === 1
				? "same-context-image-read"
				: "parallel-same-context-image-read"
			: this.firstTurnToolCalls.length === 1
				? "missing-self-injection"
				: "missing-parallel-self-injection";
	}
}

describe("read_image self mode same-context continuation (red)", () => {
	it("injects a same-chat user message with image content before continuation", async () => {
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("google", "gemini-3-pro-preview"),
				thinkingLevel: "off",
				tools: [readImageSelfTool],
			},
			transport: new ReadImageSelfContextTransport([{ id: "tc_read_1", objective: "Describe the primary image" }]),
		});

		await agent.prompt("Initial prompt");

		const messages = agent.state.messages;
		const toolResultIndex = messages.findIndex((message) => message.role === "toolResult");
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);

		const injectedUser = messages[toolResultIndex + 1];
		expect(injectedUser?.role).toBe("user");
		expect(injectedUser && hasImageContent(injectedUser)).toBe(true);
		expect(injectedUser ? getTextContent(injectedUser) : "").toContain("Describe the primary image");

		const continuation = messages[toolResultIndex + 2];
		expect(getAssistantText(continuation)).toBe("same-context-image-read");
	});

	it("keeps parallel self reads in the same chat context and preserves objective order", async () => {
		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: getModel("openai", "gpt-5.4"),
				thinkingLevel: "off",
				tools: [readImageSelfTool],
			},
			transport: new ReadImageSelfContextTransport([
				{ id: "tc_read_a", objective: "Objective A" },
				{ id: "tc_read_b", objective: "Objective B" },
			]),
		});

		await agent.prompt("Initial prompt");

		const finalAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");

		expect(getAssistantText(finalAssistant)).toBe("parallel-same-context-image-read");
	});
});
