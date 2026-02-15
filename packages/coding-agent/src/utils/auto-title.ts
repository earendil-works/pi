import type { AgentState } from "@kennyfrc/mu-agent-core";
import { type Api, completeSimple, type Message, type Model } from "@kennyfrc/mu-ai";
import { findModel, getApiKeyForModel } from "../model-config.js";

/**
 * Generate a title for the conversation based on the first user message and assistant response.
 * Uses Claude Haiku 4.5 if the provider is Anthropic, otherwise uses the current model.
 * Returns null on failure (fail silently).
 */
export async function generateTitle(state: AgentState): Promise<string | null> {
	const currentModel = state.model;
	if (!currentModel) return null;

	// Filter for relevant messages (first user + first assistant)
	const messages = state.messages.filter((m) => m.role === "user" || m.role === "assistant");
	if (messages.length < 2) return null;

	// Prepare context with truncation to save tokens
	const contextMessages = messages.slice(0, 2).map((m) => {
		let text = "";
		if (Array.isArray(m.content)) {
			text = m.content
				.filter((c: { type: string }) => c.type === "text")
				.map((c: { type: string; text?: string }) => c.text || "")
				.join(" ");
		} else {
			text = String(m.content);
		}

		// Truncate overly long messages (e.g. file dumps)
		if (text.length > 2000) {
			text = text.substring(0, 2000) + "... [truncated]";
		}

		return {
			role: m.role,
			content: [{ type: "text" as const, text }],
			timestamp: Date.now(),
		} as Message;
	});

	// Select model: prefer Haiku 4.5 for Anthropic providers, otherwise use the current model.
	// For OpenAI Codex, prefer the lightweight Spark model for speed and consistency.
	let titleModel: Model<Api> = currentModel;
	if (currentModel.provider === "anthropic") {
		// Prefer lightweight models for titling
		const haiku45 = findModel("anthropic", "claude-haiku-4-5");
		const haiku35 = findModel("anthropic", "claude-3-5-haiku-latest");

		if (haiku45.model) titleModel = haiku45.model;
		else if (haiku35.model) titleModel = haiku35.model;
	}

	if (currentModel.provider === "openai-codex") {
		const spark = findModel("openai-codex", "gpt-5.3-codex-spark");
		if (spark.model) titleModel = spark.model;
	}

	// Get API key
	const apiKey = await getApiKeyForModel(titleModel);
	if (!apiKey) return null; // Fail silently if no key for specific model

	// Build the prompt with XML protocol
	const systemPrompt = `You are a title generator. Generate a concise title (max 60 chars) for conversations.

CRITICAL CONSTRAINTS:
- You are running in a restricted sandbox with NO access to tools, files, or external resources.
- You can ONLY output text.

PROTOCOL: You MUST respond with ONLY this XML format, nothing else:
<title>Your Title Here</title>

Examples:

Input: User asks how to center a div in CSS
<title>CSS Flexbox Centering</title>

Input: User wants a Python JSON parser
<title>Python JSON Parser Script</title>

Input: User asks about let vs const
<title>JavaScript let vs const</title>`;

	// Combine context into a single user message for the title request
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
		const result = await completeSimple(
			titleModel,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `Generate a title for this conversation:\n\n${userText}` }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, maxTokens: 100 },
		);

		const responseText = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		// Parse XML tag
		const match = responseText.match(/<title>([\s\S]*?)<\/title>/i);
		if (!match) return null;

		let title = match[1].trim();
		if (title.length > 70) title = title.substring(0, 67) + "...";
		return title || null;
	} catch {
		// Fail silently on generation error
		return null;
	}
}
