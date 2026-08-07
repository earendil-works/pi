// Type declarations for the highlight.js modules pi loads directly.
// The package's ambient declarations for `highlight.js/lib/core` and
// `highlight.js/lib/languages/*` are not resolved under NodeNext, so declare
// them here.
// Note: must not import from "highlight.js" — its types reference the DOM lib,
// which changes the global Headers/URLSearchParams types and breaks other
// packages in the monorepo's single-program compile.

declare module "highlight.js/lib/core.js" {
	const hljs: {
		registerLanguage(name: string, language: (hljs?: unknown) => unknown): void;
		highlight(code: string, options: unknown): { value: string };
		highlightAuto(code: string, languageSubset?: string[]): { value: string };
		getLanguage(name: string): unknown;
		listLanguages(): string[];
	};
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	const language: (hljs?: unknown) => unknown;
	export default language;
}
