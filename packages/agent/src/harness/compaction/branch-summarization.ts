import { contentText, type Model, type Models, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";

import type { AgentMessage } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { BranchSummaryResult, Session, SessionTreeEntry } from "../types.ts";
import { BranchSummaryError, err, ok, type Result, SessionError } from "../types.ts";
import { completeSimpleWithRetries, estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** 存储在生成的分支摘要条目上的文件操作详情。 */
export interface BranchSummaryDetails {
	/** 在探索被摘要分支时读取的文件。 */
	readFiles: string[];
	/** 在探索被摘要分支时修改的文件。 */
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

/** 准备好用于摘要的分支内容。 */
export interface BranchPreparation {
	/** 选择用于分支摘要的消息。 */
	messages: AgentMessage[];
	/** 从分支提取的文件操作。 */
	fileOps: FileOperations;
	/** 所选消息的预估 token 数。 */
	totalTokens: number;
}

/** 选择用于分支摘要的条目。 */
export interface CollectEntriesResult {
	/** 按时间顺序排列的待摘要条目。 */
	entries: SessionTreeEntry[];
	/** 上一个叶节点和目标条目之间最深层的公共祖先。 */
	commonAncestorId: string | null;
}

/** 生成分支摘要的选项。 */
export interface GenerateBranchSummaryOptions {
	/** 摘要请求经过的提供商集合；拥有认证解析。 */
	models: Models;
	/** 用于摘要的模型。 */
	model: Model<any>;
	/** 摘要请求的中止信号。 */
	signal: AbortSignal;
	/** 追加到或替换默认提示词的可选指令。 */
	customInstructions?: string;
	/** 用自定义指令替换默认提示词，而不是追加。 */
	replaceInstructions?: boolean;
	/** 为提示词和模型输出预留的 token 数。默认为 16384。 */
	reserveTokens?: number;
	/** 可选的重试策略，用于瞬时摘要错误。 */
	retry?: RetryPolicy;
	/** 可选的重试回调。 */
	callbacks?: RetryCallbacks;
}

/** 在导航到不同会话树条目之前收集应被摘要的条目。 */
export async function collectEntriesForBranchSummary(
	session: Session,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}
	const oldPath = new Set((await session.getBranch(oldLeafId)).map((e) => e.id));
	const targetPath = await session.getBranch(targetId);
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}
	const entries: SessionTreeEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = await session.getEntry(current);
		if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
		entries.push(entry as SessionTreeEntry);
		current = entry.parentId;
	}
	entries.reverse();

	return { entries, commonAncestorId };
}
/**
 * 将会话树条目转换为具体的 {@link AgentMessage}，用于分支摘要。
 *
 * 与此函数的压缩版本不同，工具结果消息被排除，
 * 因为它们增加了噪音而无助于分支摘要的上下文。
 * 压缩条目在此处也被映射为摘要消息。
 */
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "thinking_level_change":
		case "model_change":
		case "active_tools_change":
		case "custom":
		case "label":
		case "session_info":
		case "leaf":
			return undefined;
	}
}

/**
 * 在可选的 token 预算内准备用于摘要的分支条目。
 *
 * 按时间倒序遍历条目，收集消息直到 token 预算耗尽。
 * 文件操作从条目级分支摘要详情和单个助手消息中提取。
 * 当设置了预算且即将超出时，压缩和分支摘要条目如果
 * 落在预算的 90% 以内仍会被包含，以保留关键的上下文标记。
 */
export function prepareBranchEntries(entries: SessionTreeEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

/** 附加在每个分支摘要前面的前言，用于表明它涵盖了不同的对话分支。 */
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/** 指示模型为已放弃的对话分支创建结构化摘要的提示词模板。 */
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 为已放弃的分支条目生成摘要。
 *
 * 从分支条目中准备消息，token 预算由模型的上下文窗口减去预留 token 数得出。
 * 文件操作（读取、写入、编辑）被跟踪并以元数据标签的形式追加。
 * 摘要以一段前言开头，说明用户曾探索了不同的分支。
 */
export async function generateBranchSummary(
	entries: SessionTreeEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const {
		models,
		model,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		retry,
		callbacks,
	} = options;
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];
	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ signal, maxTokens: 2048 },
		retry,
		callbacks,
	);
	if (response.stopReason === "aborted") {
		return err(new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new BranchSummaryError(
				"summarization_failed",
				`Branch summary failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	let summary = contentText(response.content);
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	});
}
