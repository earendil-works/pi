import hljs, { type LanguageDefinition } from "highlight.js/lib/core.js";
import {
	HIGHLIGHT_LANGUAGE_ALIASES,
	HIGHLIGHT_LANGUAGE_DEFINITIONS,
	HIGHLIGHT_LANGUAGE_DEPENDENCIES,
	HIGHLIGHT_LANGUAGE_LOADERS,
} from "./highlight-languages.ts";
import { decodeHtmlEntityAt } from "./html.ts";

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

interface HighlightLanguage {
	name: string;
	definition: LanguageDefinition;
}

type HighlightLanguageLoadEvent =
	| { language: string; languages: HighlightLanguage[] }
	| { language: string; error: unknown };
type HighlightLanguageLoadListener = (event: HighlightLanguageLoadEvent) => void;

interface LanguageRegistryState {
	definitions: Map<string, Promise<LanguageDefinition>>;
	requests: Map<string, Promise<HighlightLanguage[]>>;
	listeners: Set<HighlightLanguageLoadListener>;
}

// jiti can evaluate this module more than once. Share imported definitions and
// listeners so extension-triggered loads still refresh the host TUI.
const LANGUAGE_REGISTRY_KEY = Symbol.for("@earendil-works/pi-coding-agent:highlight-language-loaders-v4");
const globalRegistry = globalThis as Record<symbol, LanguageRegistryState | undefined>;
const languageRegistry: LanguageRegistryState = globalRegistry[LANGUAGE_REGISTRY_KEY] ?? {
	definitions: new Map(),
	requests: new Map(),
	listeners: new Set(),
};
globalRegistry[LANGUAGE_REGISTRY_KEY] = languageRegistry;

const registeredLanguages = new Set<string>();
for (const [name, definition] of Object.entries(HIGHLIGHT_LANGUAGE_DEFINITIONS)) {
	hljs.registerLanguage(name, definition);
	registeredLanguages.add(name);
}

function getCanonicalLanguageName(name: string): string | undefined {
	if (Object.hasOwn(HIGHLIGHT_LANGUAGE_DEFINITIONS, name) || Object.hasOwn(HIGHLIGHT_LANGUAGE_LOADERS, name)) {
		return name;
	}
	return HIGHLIGHT_LANGUAGE_ALIASES.get(name);
}

function notifyLanguageLoad(event: HighlightLanguageLoadEvent): void {
	if (languageRegistry.listeners.size > 0) {
		for (const listener of languageRegistry.listeners) listener(event);
	} else if ("error" in event) {
		const message = event.error instanceof Error ? event.error.message : String(event.error);
		console.error(`Failed to load syntax highlighting language "${event.language}": ${message}`);
	}
}

function loadLanguageDefinition(name: string): Promise<LanguageDefinition> {
	const eagerDefinition = HIGHLIGHT_LANGUAGE_DEFINITIONS[name];
	if (eagerDefinition) return Promise.resolve(eagerDefinition);

	let promise = languageRegistry.definitions.get(name);
	if (!promise) {
		const loader = HIGHLIGHT_LANGUAGE_LOADERS[name];
		promise = Promise.resolve()
			.then(loader)
			.then(
				({ default: definition }) => definition,
				(error: unknown) => {
					notifyLanguageLoad({ language: name, error });
					throw error;
				},
			);
		languageRegistry.definitions.set(name, promise);
	}
	return promise;
}

async function loadLanguageClosure(name: string, visited = new Set<string>()): Promise<HighlightLanguage[]> {
	if (visited.has(name)) return [];
	visited.add(name);
	const definition = await loadLanguageDefinition(name);
	const languages: HighlightLanguage[] = [];
	for (const dependency of HIGHLIGHT_LANGUAGE_DEPENDENCIES.get(name) ?? []) {
		languages.push(...(await loadLanguageClosure(dependency, visited)));
	}
	languages.push({ name, definition });
	return languages;
}

function registerLanguages(languages: HighlightLanguage[], requestedName: string): boolean {
	for (const { name, definition } of languages) {
		if (registeredLanguages.has(name)) continue;
		hljs.registerLanguage(name, definition);
		registeredLanguages.add(name);
	}
	return registeredLanguages.has(requestedName);
}

function getLanguageRequest(name: string): Promise<HighlightLanguage[]> {
	let request = languageRegistry.requests.get(name);
	if (!request) {
		request = loadLanguageClosure(name);
		languageRegistry.requests.set(name, request);
		void request.then(
			(languages) => notifyLanguageLoad({ language: name, languages }),
			() => {},
		);
	}
	return request;
}

export function onHighlightLanguageLoad(listener: HighlightLanguageLoadListener): () => void {
	const localListener: HighlightLanguageLoadListener = (event) => {
		if ("languages" in event) registerLanguages(event.languages, event.language);
		listener(event);
	};
	languageRegistry.listeners.add(localListener);
	return () => languageRegistry.listeners.delete(localListener);
}

export async function loadHighlightLanguage(name: string): Promise<boolean> {
	const normalizedName = name.toLowerCase();
	const canonicalName = getCanonicalLanguageName(normalizedName);
	if (!canonicalName) return supportsLanguage(normalizedName);
	if (registeredLanguages.has(canonicalName)) return true;
	return registerLanguages(await getLanguageRequest(canonicalName), canonicalName);
}

/** Return the canonical grammar when ready, starting a background load when needed. */
export function requestHighlightLanguage(name: string): string | undefined {
	const normalizedName = name.toLowerCase();
	const canonicalName = getCanonicalLanguageName(normalizedName);
	if (!canonicalName) return supportsLanguage(normalizedName) ? normalizedName : undefined;
	if (registeredLanguages.has(canonicalName)) {
		return normalizedName === "html" || normalizedName === "toml" ? normalizedName : canonicalName;
	}
	void getLanguageRequest(canonicalName).then(
		(languages) => registerLanguages(languages, canonicalName),
		() => {},
	);
	return undefined;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name.toLowerCase()) !== undefined;
}
