import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * agent 循环使用的流函数。`Models.streamSimple` 满足此形状。
 *
 * 契约：
 * - 对于请求/模型/运行时失败，不得抛出异常或返回 reject 的 promise。
 * - 必须返回一个 AssistantMessageEventStream。
 * - 失败必须通过协议事件以及一个 stopReason 为 "error" 或 "aborted" 且带 errorMessage 的
 *   最终 AssistantMessage 编码到返回的流中。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 控制单条 assistant 消息中的工具调用如何执行。
 *
 * - "sequential"：每个工具调用在上一个完成后才准备、执行和最终化。
 * - "parallel"：工具调用按顺序预检，然后允许的工具并发执行。
 *   每个工具最终化后按完成顺序发出 `tool_execution_end`，
 *   而工具结果消息则稍后按 assistant 源顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制 agent 循环到达队列排空点时注入多少条排队的用户消息。
 *
 * - "all"：在该点排空并注入所有排队消息。
 * - "one-at-a-time"：仅排空并注入最早的一条排队消息，其余留待后续排空点处理。
 */
export type QueueMode = "all" | "one-at-a-time";

/** assistant 消息发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 返回的结果。
 *
 * 返回 `{ block: true }` 可阻止工具执行，loop 会改为发出错误工具结果。
 * `reason` 会成为该错误结果中显示的文本。如果省略，则使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖结果。
 *
 * 合并语义为逐字段覆盖：
 * - `content`：如果提供，完整替换工具结果的内容数组
 * - `details`：如果提供，完整替换工具结果的 details 值
 * - `isError`：如果提供，替换工具结果的错误标志
 * - `usage`：如果提供，替换工具结果的 usage
 * - `terminate`：如果提供，替换提前终止提示
 *
 * 未提供的字段保留已执行工具结果的原始值。
 * `content`、`details` 和 `usage` 不执行深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** 工具执行本身的 usage，如果有的话。不用于主 LLM 上下文的计费统计。 */
	usage?: Usage;
	/**
	 * 提示 agent 应在当前工具批次完成后停止。
	 * 仅当批次中每个已最终化的工具结果都将此设为 true 时，才会触发提前终止。
	 */
	terminate?: boolean;
}

/** 传递给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 请求该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 已验证的、针对目标工具 schema 的工具参数。 */
	args: unknown;
	/** 工具调用准备时的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传递给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 针对目标工具 schema 验证后的工具参数。 */
	args: unknown;
	/** 应用 `afterToolCall` 覆盖之前的已执行工具结果。 */
	result: AgentToolResult<any>;
	/** 已执行的工具结果当前是否被视为错误。 */
	isError: boolean;
	/** 工具调用最终化时的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传递给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成该 turn 的 assistant 消息。 */
	message: AssistantMessage;
	/** 传递给前置 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 在该 turn 的 assistant 消息和工具结果追加后的当前 agent 上下文。 */
	context: AgentContext;
	/** 如果在此点退出，本轮循环调用将返回的消息。prompt 运行包含初始提示消息；continuation 运行不包含已有的上下文消息。 */
	newMessages: AgentMessage[];
}

/** agent 循环在发起下一次 provider 请求前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次 provider 请求的上下文。 */
	context?: AgentContext;
	/** 下一次 provider 请求的模型。 */
	model?: Model<any>;
	/** 下一次 provider 请求的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用前将 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 *
	 * 每个 AgentMessage 必须被转换为 LLM 可以理解的 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（例如仅用于 UI 的通知、状态消息）应当被过滤掉。
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。应返回安全的回退值。
	 * 抛出异常会中断底层 agent loop，导致无法产生正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉仅用于 UI 的消息
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前对上下文应用的可选变换。
	 *
	 * 用于在 AgentMessage 层面进行的操作：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 从外部来源注入上下文
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。应返回原始消息或其他安全的回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥。
	 *
	 * 适用于可能在长时间运行的工具执行阶段过期的短期 OAuth 令牌（例如 GitHub Copilot）。
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。无可用密钥时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 在每次 turn 完全完成且 `turn_end` 已发出后调用。
	 *
	 * 如果返回 true，则 loop 发出 `agent_end` 并退出，不再检查 steering 或 follow-up 队列，
	 * 也不会发起下一次 LLM 调用。当前 assistant 响应和任何工具执行会正常完成。
	 *
	 * 用于在当前 turn 完成后请求优雅停止，例如在上下文即将超出限制之前。
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。抛出异常会中断底层 agent loop，导致无法产生正常的事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、loop 决定是否发起下一次 provider 请求之前调用。
	 * 返回替换的 context/model/thinking 状态以影响本次运行的下一轮。
	 * 返回 undefined 则继续使用当前 context/config。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在运行中注入对话的 steering 消息。
	 *
	 * 在当前 assistant turn 完成工具调用执行后调用，除非 `shouldStopAfterTurn` 先退出。
	 * 如果返回消息，则在下一次 LLM 调用前将其添加到上下文中。
	 * 当前 assistant 消息中的工具调用不会被跳过。
	 *
	 * 用于在 agent 工作时对其进行"引导"。
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。无可用 steering 消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 agent 本应停止后需要处理的 follow-up 消息。
	 *
	 * 当 agent 没有更多工具调用且没有 steering 消息时调用。
	 * 如果返回消息，则将其添加到上下文中，agent 会继续进行下一轮。
	 *
	 * 用于需要等到 agent 完成后再处理的后续消息。
	 *
	 * 约定：不得抛出异常或返回被拒绝的 Promise。无可用 follow-up 消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：依次预检工具调用，然后并发执行允许的工具；
	 *   每个工具最终化后按完成顺序发出 `tool_execution_end`，
	 *   然后按 assistant 源顺序发出工具结果消息
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行前、参数验证后调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，loop 会改为发出错误工具结果。
	 * 该钩子接收 agent 的 abort signal 并负责响应它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成后、`tool_execution_end` 和工具结果消息事件发出之前调用。
	 *
	 * 返回 `AfterToolCallResult` 以覆盖已执行工具结果的部分字段：
	 * - `content` 替换完整的内容数组
	 * - `details` 替换完整的 details 负载
	 * - `isError` 替换错误标志
	 * - `usage` 替换 tool result usage
	 * - `terminate` 替换提前终止提示
	 *
	 * 未提供的字段保留其原始值。不执行深度合并。
	 * 该钩子接收 agent 的 abort signal 并负责响应它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考/推理功能的模型的思考级别。
 * 注意："xhigh" 和 "max" 仅受部分模型系列支持。使用来自 @earendil-works/pi-ai 的
 * 模型 thinking-level 元数据来检测具体模型是否支持。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 用于自定义应用消息的可扩展接口。
 * 应用可通过声明合并进行扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 —— 应用通过声明合并进行扩展
}

/**
 * AgentMessage：LLM 消息与自定义消息的联合类型。
 * 此抽象允许应用添加自定义消息类型，同时保持类型安全以及与基础 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 公开的 agent 状态。
 *
 * `tools` 和 `messages` 使用访问器属性，以便实现在存储之前可以复制传入的数组。
 */
export interface AgentState {
	/** 每次模型请求时发送的系统提示词。 */
	systemPrompt: string;
	/** 用于后续 turn 的当前活跃模型。 */
	model: Model<any>;
	/** 用于后续 turn 的请求推理级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋值新数组时会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话记录。赋值新数组时会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * agent 正在处理 prompt 或 continuation 时为 true。
	 *
	 * 此值在等待的 `agent_end` 监听器全部完成之前保持为 true。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分 assistant 消息（如果有的话）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 ID。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的 assistant turn 的错误消息（如果有的话）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 用于日志或 UI 渲染的任意结构化详情。 */
	details: T;
	/** 工具执行本身的 usage，如果有的话。不用于主 LLM 上下文的计费统计。 */
	usage?: Usage;
	/** 由此结果引入、从此对话点开始可用的工具名称。 */
	addedToolNames?: string[];
	/**
	 * 提示 agent 应在当前工具批次完成后停止。
	 * 仅当批次中每个已最终化的工具结果都将此设为 true 时，才会触发提前终止。
	 */
	terminate?: boolean;
}

/**
 * 工具用于流式传输部分执行更新的回调。
 *
 * 该回调的作用域限定在当前 `execute()` 调用内。在工具 promise 敲定之后进行的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 用于 UI 显示的人类可读标签。 */
	label: string;
	/**
	 * 在 schema 验证之前对原始工具调用参数的可选兼容性适配。
	 * 必须返回匹配 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用。失败时抛出异常，而不是在 `content` 中编码错误。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 单个工具的执行模式覆盖。
	 * - "sequential"：此工具必须与其他工具调用逐个执行。
	 * - "parallel"：此工具可以与其他工具调用并发执行。
	 *
	 * 如果省略，则应用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层 agent 循环的上下文快照。 */
export interface AgentContext {
	/** 随请求包含的系统提示词。 */
	systemPrompt: string;
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 发出的用于 UI 更新的事件。
 *
 * `agent_end` 是一次运行中发出的最后一个事件，但等待该事件的 `Agent.subscribe()`
 * 监听器仍然属于运行结算的一部分。agent 仅在这些监听器完成后才会变为空闲状态。
 */
export type AgentEvent =
	// agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// turn 生命周期 —— 一个 turn 包含一次 assistant 响应加上任何工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 —— 针对 user、assistant 和 toolResult 消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式传输期间针对 assistant 消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
