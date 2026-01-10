/**
 * Build the Codex system prompt from components.
 */
export function buildCodexSystemPrompt(args) {
	const { codexInstructions, bridgeText, userSystemPrompt } = args;
	const developerMessages = [];
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
//# sourceMappingURL=system-prompt.js.map
