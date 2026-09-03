interface HighlightJsResult {
	value: string;
}

interface HighlightJsOptions {
	language: string;
	ignoreIllegals?: boolean;
}

interface HighlightJsLanguageDefinition {
	readonly name?: string;
}

type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguageDefinition;

interface HighlightJsApi {
	highlight(code: string, options: HighlightJsOptions): HighlightJsResult;
	highlightAuto(code: string, languageSubset?: string[]): HighlightJsResult;
	getLanguage(name: string): HighlightJsLanguageDefinition | undefined;
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
}

declare module "highlight.js/lib/core.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

declare module "highlight.js/lib/index.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	const language: HighlightJsLanguageFactory;
	export default language;
}
