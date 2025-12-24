/** Z.ai provider-specific options */
export interface ZAICompletionsOptions extends Record<string, unknown> {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	webSearch?: boolean;
	webSearchEngine?: "search_pro_jina";
	webSearchCount?: number;
	webSearchDomainFilter?: string;
	webSearchRecencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
	webSearchContentSize?: "medium" | "high";
	webSearchResultSequence?: "before" | "after";
	webSearchReturnResults?: boolean;
	webSearchRequireSearch?: boolean;
	webSearchPrompt?: string;
	knowledgeBaseId?: string;
	knowledgeBasePromptTemplate?: string;
}
//# sourceMappingURL=zai-completions.d.ts.map
