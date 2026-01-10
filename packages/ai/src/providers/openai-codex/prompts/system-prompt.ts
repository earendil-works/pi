/**
 * Build the Codex system prompt from components.
 */

export interface CodexSystemPrompt {
	instructions: string;
	developerMessages: string[];
}

export function buildCodexSystemPrompt(args: {
	codexInstructions: string;
	bridgeText: string;
	userSystemPrompt?: string;
}): CodexSystemPrompt {
	const { codexInstructions, bridgeText, userSystemPrompt } = args;
	const developerMessages: string[] = [];

	if (bridgeText.trim().length > 0) {
		developerMessages.push(bridgeText.trim());
	}

	if (userSystemPrompt && userSystemPrompt.trim().length > 0) {
		developerMessages.push(userSystemPrompt.trim());
	}

	return {
		instructions: codexInstructions.trim(),
		developerMessages,
	};
}
