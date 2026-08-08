import type { AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Agent } from "../../agent.ts";
import type { AgentMessage, AgentTool, AgentToolResult, StreamFn, ThinkingLevel } from "../../types.ts";

/**
 * Parameters for the `task` tool.
 */
export const taskParametersSchema = Type.Object({
	prompt: Type.String({ description: "Instructions for the subagent." }),
	description: Type.Optional(Type.String({ description: "Short label describing what this subagent should do." })),
	schema: Type.Optional(
		Type.Object(
			{
				description: Type.Optional(Type.String()),
				properties: Type.Record(Type.String(), Type.Any(), {
					description: "TypeBox schema for each expected result field.",
				}),
				required: Type.Optional(
					Type.Array(Type.String(), { description: "Field names that must be present in the result." }),
				),
			},
			{
				description:
					"Expected structured output. When provided, the subagent's final text is parsed as JSON and validated against this schema before being returned.",
			},
		),
	),
});

export type TaskParameters = Static<typeof taskParametersSchema>;

/** Structured details returned alongside the subagent's output. */
export interface TaskToolDetails {
	/** Short label describing the subagent's task. */
	summary: string;
	/** Number of messages produced by the subagent's transcript. */
	messageCount: number;
	/** Wall-clock duration of the subagent run in milliseconds. */
	durationMs: number;
	/** Whether the result went through JSON schema extraction/validation. */
	hasStructuredResult: boolean;
}

/** Options for constructing the `task` tool. */
export interface TaskToolOptions {
	model: Model<any>;
	streamFn: StreamFn;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** System prompt for the subagent. Defaults to the parent's system prompt if omitted. */
	systemPrompt?: string;
	/** Lazily resolved system prompt, evaluated per subagent spawn. Takes precedence over `systemPrompt` when both are set. */
	getSystemPrompt?: () => string;
	/** Tools the subagent may use. Defaults to no tools (text-only subagents). */
	tools?: AgentTool<any>[];
	/** Thinking level for the subagent. Defaults to "off". */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Extracts the first balanced JSON object from arbitrary assistant text,
 * preferring a fenced ```json block. Returns undefined when no JSON is found.
 */
export function extractJson(text: string): unknown | undefined {
	const fence = text.match(/```json\s*([\s\S]*?)```/i);
	const candidate = (fence ? fence[1] : text).trim();
	const start = candidate.indexOf("{");
	if (start === -1) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * The `task` tool: spawns an isolated subagent, waits for it to finish, and
 * returns its output. When a `schema` is provided the subagent's final text is
 * parsed as JSON and validated (required fields checked) before being returned,
 * so the parent gets a typed result instead of prose to parse.
 */
export function createTaskTool(options: TaskToolOptions): AgentTool<typeof taskParametersSchema> {
	const systemPrompt = options.getSystemPrompt?.() ?? options.systemPrompt ?? "";
	const tools = options.tools ?? [];
	const thinkingLevel = options.thinkingLevel ?? "off";

	return {
		name: "task",
		label: "task",
		description:
			"Split work across a subagent. Runs the given prompt in an isolated agent with its own transcript and tool surface, waits for it to finish, and returns its output. Provide a `schema` to receive a validated structured JSON result instead of prose.",
		parameters: taskParametersSchema,
		async execute(_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<TaskToolDetails>> {
			const subagent = new Agent({
				streamFn: options.streamFn,
				convertToLlm: options.convertToLlm,
				getApiKey: options.getApiKey,
				initialState: {
					model: options.model,
					systemPrompt,
					tools,
					thinkingLevel,
					messages: [],
				},
			});

			if (signal) {
				if (signal.aborted) {
					throw new Error("Subagent task was aborted before it started.");
				}
				signal.addEventListener("abort", () => subagent.abort(), { once: true });
			}

			const started = Date.now();
			await subagent.prompt(params.prompt);

			const messages = subagent.state.messages;
			const text = messages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.flatMap((m) => m.content)
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			let result: unknown;
			if (params.schema) {
				result = extractJson(text);
				if (result === undefined) {
					throw new Error(
						`Subagent did not return a JSON object matching the requested schema.\nRaw output:\n${text}`,
					);
				}
				if (params.schema.required) {
					for (const key of params.schema.required) {
						if (!(typeof result === "object" && result !== null && key in result)) {
							throw new Error(`Subagent JSON result is missing required field "${key}".`);
						}
					}
				}
			} else {
				result = { summary: text };
			}

			const summary =
				params.description ??
				(typeof result === "object" && result !== null && "summary" in result
					? String((result as { summary: unknown }).summary)
					: text.slice(0, 200));

			const details: TaskToolDetails = {
				summary,
				messageCount: messages.length,
				durationMs: Date.now() - started,
				hasStructuredResult: Boolean(params.schema),
			};

			return {
				content: [{ type: "text", text: params.schema ? JSON.stringify(result, null, 2) : text }],
				details,
			};
		},
	};
}
