import type { AgentState } from "@kennyfrc/mu-agent-core";
import { type Api, completeSimple, type Message, type Model } from "@kennyfrc/mu-ai";
import { findModel, getApiKeyForModel } from "../model-config.js";

export interface ThreadListingMeta {
	title: string;
	preview: string;
}

const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>\n\n)+/;

export function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "");
}

export function parseThreadListingMetaXml(responseText: string): ThreadListingMeta | null {
	const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
	const previewMatch = responseText.match(/<preview>([\s\S]*?)<\/preview>/i);
	if (!titleMatch || !previewMatch) return null;

	const title = titleMatch[1].trim();
	const preview = previewMatch[1].trim();
	if (!title || !preview) return null;

	return { title, preview };
}

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const blocks = content as unknown[];
	const texts: string[] = [];
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		const rec = block as Record<string, unknown>;
		if (rec.type !== "text") continue;
		const text = rec.text;
		if (typeof text === "string") texts.push(text);
	}
	return texts.join(" ");
}

function selectThreadMetaModel(currentModel: Model<Api>): Model<Api> {
	if (currentModel.provider === "anthropic") {
		const haiku45 = findModel("anthropic", "claude-haiku-4-5");
		const haiku35 = findModel("anthropic", "claude-3-5-haiku-latest");
		if (haiku45.model) return haiku45.model;
		if (haiku35.model) return haiku35.model;
	}

	if (currentModel.provider === "openai-codex") {
		const spark = findModel("openai-codex", "gpt-5.3-codex-spark");
		if (spark.model) return spark.model;
	}

	return currentModel;
}

/**
 * Generate a title + listing preview for the conversation based on the first user message
 * and the first assistant response.
 *
 * Returns null on failure (fail silently).
 */
export async function generateThreadListingMeta(state: AgentState): Promise<ThreadListingMeta | null> {
	const currentModel = state.model;
	if (!currentModel) return null;

	const messages = state.messages.filter((m) => m.role === "user" || m.role === "assistant");
	if (messages.length < 2) return null;

	const contextMessages = messages.slice(0, 2).map((m) => {
		let text = extractTextFromMessageContent(m.content);
		if (m.role === "user") text = stripUserMessageTimePrefix(text);

		if (text.length > 2000) {
			text = text.substring(0, 2000) + "... [truncated]";
		}

		return {
			role: m.role,
			content: [{ type: "text" as const, text }],
			timestamp: Date.now(),
		} as Message;
	});

	const metaModel = selectThreadMetaModel(currentModel);
	const apiKey = await getApiKeyForModel(metaModel);
	if (!apiKey) return null;

	const systemPrompt = `You are a title/preview generator.

Generate:
- A concise title (max 60 chars)
- A concise listing preview (max 200 chars)

CRITICAL CONSTRAINTS:
- You are running in a restricted sandbox with NO access to tools, files, or external resources.
- You can ONLY output text.

PROTOCOL: You MUST respond with ONLY this XML format, nothing else:
<title>Your Title Here</title>
<preview>Your Preview Here</preview>`;

	const userText = contextMessages
		.map((m) => {
			const role = m.role === "user" ? "User" : "Assistant";
			const content = m.content as Array<{ type: string; text?: string }>;
			const text = content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join(" ");
			return `${role}: ${text}`;
		})
		.join("\n\n");

	try {
		const options =
			metaModel.provider === "openai-codex"
				? ({ apiKey, maxTokens: 150, reasoning: "xhigh" } as const)
				: ({ apiKey, maxTokens: 150 } as const);

		const result = await completeSimple(
			metaModel,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `Generate title + preview:\n\n${userText}` }],
						timestamp: Date.now(),
					},
				],
			},
			options,
		);

		const responseText = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		const parsed = parseThreadListingMetaXml(responseText);
		if (!parsed) return null;

		let title = parsed.title;
		if (title.length > 70) title = title.substring(0, 67) + "...";

		let preview = parsed.preview;
		if (preview.length > 220) preview = preview.substring(0, 217) + "...";

		return { title, preview };
	} catch {
		return null;
	}
}

/**
 * Backwards-compatible wrapper used by older call sites.
 */
export async function generateTitle(state: AgentState): Promise<string | null> {
	const meta = await generateThreadListingMeta(state);
	return meta?.title ?? null;
}
