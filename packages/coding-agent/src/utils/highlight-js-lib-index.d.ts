declare module "highlight.js/lib/core.js" {
	export type LanguageDefinition = (hljs: HighlightJs) => unknown;

	interface HighlightJs {
		highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
		highlightAuto(code: string, languageSubset?: string[]): { value: string };
		getLanguage(name: string): unknown;
		registerLanguage(name: string, definition: LanguageDefinition): void;
	}

	const hljs: HighlightJs;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	import type { LanguageDefinition } from "highlight.js/lib/core.js";
	const definition: LanguageDefinition;
	export default definition;
}
