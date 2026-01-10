/**
 * Build the Codex system prompt from components.
 */
export interface CodexSystemPrompt {
	instructions: string;
	developerMessages: string[];
}
export declare function buildCodexSystemPrompt(args: {
	codexInstructions: string;
	bridgeText: string;
	userSystemPrompt?: string;
}): CodexSystemPrompt;
//# sourceMappingURL=system-prompt.d.ts.map
