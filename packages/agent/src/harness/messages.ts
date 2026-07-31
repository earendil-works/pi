import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";

/**
 * 向 LLM 展示压缩摘要时使用的前缀。
 * 摘要文本插入在此前缀和 {@link COMPACTION_SUMMARY_SUFFIX} 之间。
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

/**
 * 向 LLM 展示压缩摘要时使用的后缀，用于闭合压缩摘要包装。
 * 与 {@link COMPACTION_SUMMARY_PREFIX} 配对使用。
 */
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * 向 LLM 展示分支摘要时使用的前缀。
 * 当对话从子代理分支返回时插入分支摘要，提供该分支中已完成操作的上下文。
 * 摘要文本插入在此前缀和 {@link BRANCH_SUMMARY_SUFFIX} 之间。
 */
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

/**
 * 向 LLM 展示分支摘要时使用的后缀，用于闭合分支摘要包装。
 * 与 {@link BRANCH_SUMMARY_PREFIX} 配对使用。
 */
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * 表示由 harness 捕获的 bash/shell 命令执行事件。
 * 通过 {@link bashExecutionToText} 转换为对 LLM 可见的 user 角色消息。
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

/**
 * 表示应用自定义消息，可以包含文本、图片或任意详细数据。
 * 当 {@link display} 为 true 时，在 LLM 上下文中显示为 user 角色消息。
 *
 * @typeParam T - 可选 {@link details} 载荷的类型。
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

/**
 * 表示对话从子代理分支返回时的摘要。
 * 转换为 LLM 可见消息时，用 {@link BRANCH_SUMMARY_PREFIX} 和 {@link BRANCH_SUMMARY_SUFFIX}
 * 包装。
 */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

/**
 * 表示对话压缩摘要，当上下文窗口过大时替换较早的消息。
 * 转换为 LLM 可见消息时，用 {@link COMPACTION_SUMMARY_PREFIX} 和
 * {@link COMPACTION_SUMMARY_SUFFIX} 包装。
 */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

declare module "../types.ts" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * 将 {@link BashExecutionMessage} 转换为对 LLM 可见的人类可读文本表示。
 * 包括执行的命令、输出（用代码块包裹）、退出码、取消状态以及
 * 适用时的截断提示。
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/**
 * 创建一个 {@link BranchSummaryMessage}，捕获在返回主对话前子代理分支中
 * 发生的事件。
 *
 * @param summary - 分支活动的人类可读摘要。
 * @param fromId - 此摘要来源的分支标识符。
 * @param timestamp - 表示摘要创建时间的 ISO-8601 时间戳字符串。
 * @returns 一个新的 {@link BranchSummaryMessage} 实例。
 */
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 创建一个 {@link CompactionSummaryMessage}，对话历史被压缩以保持在
 * 上下文窗口限制内后的摘要。
 *
 * @param summary - 较早对话历史的压缩摘要。
 * @param tokensBefore - 压缩发生前的近似 token 数量。
 * @param timestamp - 表示压缩发生时间的 ISO-8601 时间戳字符串。
 * @returns 一个新的 {@link CompactionSummaryMessage} 实例。
 */
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 为应出现在 LLM 对话上下文中的应用自定义内容创建一个 {@link CustomMessage}。
 *
 * @param customType - 标识自定义消息类型的字符串标签。
 * @param content - 消息内容，可以是纯文本字符串或文本/图片块数组。
 * @param display - 此消息是否应在 LLM 上下文中可见。
 * @param details - 与消息关联的可选任意载荷。
 * @param timestamp - 表示消息创建时间的 ISO-8601 时间戳字符串。
 * @returns 一个新的 {@link CustomMessage} 实例。
 */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 将 {@link AgentMessage} 对象数组转换为标准 LLM {@link Message} 格式，
 * 用于模型提供商 API。
 *
 * 角色转换规则：
 * - **bashExecution**：转换为 `user` 角色消息，命令输出通过
 *   {@link bashExecutionToText} 渲染。如果 `excludeFromContext` 为 true，
 *   则完全跳过。
 * - **custom**：转换为 `user` 角色消息，直接使用消息的
 *   内容（字符串或结构化内容数组）。
 * - **branchSummary**：转换为 `user` 角色消息，摘要文本用
 *   {@link BRANCH_SUMMARY_PREFIX}/{@link BRANCH_SUMMARY_SUFFIX} 包装。
 * - **compactionSummary**：转换为 `user` 角色消息，摘要文本用
 *   {@link COMPACTION_SUMMARY_PREFIX}/{@link COMPACTION_SUMMARY_SUFFIX} 包装。
 * - **user / assistant / toolResult**：原样传递
 *   （已经是标准 LLM 消息格式）。
 * - **所有其他角色**：过滤掉（从结果中省略）。
 *
 * @param messages - 要转换的代理消息数组。
 * @returns 适用于模型提供商的标准 LLM {@link Message} 对象数组。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					return undefined;
			}
		})
		.filter((m): m is Message => m !== undefined);
}
