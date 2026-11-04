// The chat editor's completion (p2-tui-port.md section 8.4, P7b): pi-tui's CombinedAutocompleteProvider behavior over
// p2 sources. `/` goes to the command registry's slash completion; `@prefix` asks the session's FileIndex (ranked like
// pi's `@`); a forced Tab on a path-like token lists that directory (`FileIndex.list`) and filters it locally. Never
// pi-tui's own provider: it reads the local filesystem and spawns fd. Requests are aborted when superseded (the
// editor's signal) and debounced by the editor for `@`.
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import {
	applyFileCompletion,
	atItems,
	extractAtPrefix,
	extractPathPrefix,
	isMentionToken,
	mentionItems,
	outOfScope,
	parsePathPrefix,
	pathCompletion,
	pathItems,
	shouldTriggerFileCompletion,
} from "../runtime/completion.ts";

/** What the provider needs from a session's FileIndex (a live `FileIndex` reader reference satisfies it). */
export type FileSource = {
	complete(args: { query: string; limit?: number }): Promise<{
		items: { path: string; dir: boolean }[];
		truncated: boolean;
	}>;
	list(args: { path: string }): Promise<{ entries: { name: string; dir: boolean }[]; truncated: boolean }>;
};

export const OUT_OF_SCOPE_HINT = "File completion covers the session directory only";
export const PARTIAL_HINT = "File index is partial (the directory is very large)";

export class FileCompletionProvider implements AutocompleteProvider {
	readonly triggerCharacters = ["@"];
	private slash: AutocompleteProvider;
	private files: () => FileSource | undefined;
	private hint: (text: string) => void;
	/** Which source answered the last request: its prefix kind decides how a chosen item is inserted. */
	private lastKind: "slash" | "file" = "file";

	/** The agent's name while chat mode is on (its `@name` is offered first), else undefined. */
	private mentions: () => string | undefined;

	constructor(
		slash: AutocompleteProvider,
		files: () => FileSource | undefined,
		hint: (text: string) => void,
		mentions: () => string | undefined = () => undefined,
	) {
		this.slash = slash;
		this.files = files;
		this.hint = hint;
		this.mentions = mentions;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const at = extractAtPrefix(before);
		if (at !== null) {
			this.lastKind = "file";
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(at);
			// `@pi` is chat mode's mention, never a file; in chat mode it is offered first (section 8.4).
			if (isMentionToken(at, this.mentions())) return null;
			const mention: AutocompleteItem[] = mentionItems(rawPrefix, this.mentions());
			if (outOfScope(rawPrefix)) {
				this.hint(OUT_OF_SCOPE_HINT);
				return mention.length ? { items: mention, prefix: at } : null;
			}
			const files = this.files();
			const result = files
				? await files.complete({ query: rawPrefix, limit: 20 }).catch(() => undefined)
				: undefined;
			if (options.signal.aborted) return null;
			if (result?.truncated) this.hint(PARTIAL_HINT);
			const items = [...mention, ...atItems(result?.items ?? [], { isQuotedPrefix })];
			return items.length ? { items, prefix: at } : null;
		}
		if (!options.force && before.trimStart().startsWith("/")) {
			this.lastKind = "slash";
			return this.slash.getSuggestions(lines, cursorLine, cursorCol, options);
		}
		if (!options.force) return null;
		// Tab in a command's argument (`/cd sr`): the command's own completion first (pi's argument completions), then
		// files as anywhere else.
		if (/^\s*\/\S+\s/.test(before)) {
			const own = await this.slash.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			if (own?.items.length) {
				this.lastKind = "slash";
				return own;
			}
		}
		const prefix = extractPathPrefix(before, true);
		if (prefix === null) return null;
		this.lastKind = "file";
		const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
		if (outOfScope(rawPrefix)) {
			this.hint(OUT_OF_SCOPE_HINT);
			return null;
		}
		const files = this.files();
		if (!files) return null;
		const listed = await files.list({ path: pathCompletion(rawPrefix).dir }).catch(() => undefined);
		if (!listed || options.signal.aborted) return null;
		const items = pathItems(listed.entries, rawPrefix, { isAtPrefix, isQuotedPrefix });
		return items.length ? { items, prefix } : null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (this.lastKind === "slash") return this.slash.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const result = applyFileCompletion(lines[cursorLine] ?? "", cursorCol, item, prefix);
		const next = [...lines];
		next[cursorLine] = result.line;
		return { lines: next, cursorLine, cursorCol: result.cursorCol };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return shouldTriggerFileCompletion((lines[cursorLine] ?? "").slice(0, cursorCol));
	}
}
