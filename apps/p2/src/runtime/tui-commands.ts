// One registry drives keys, palette, slash commands and help (p2-tui-port.md section 6). The dispatcher implements
// stages 3-4 of the section 6.2 precedence contract inside the worker; stage 1 is the launcher, stage 2 pi-tui's
// alt screen (which runs before the focused component), stage 5 the focused component.

import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
} from "@earendil-works/pi-tui";
import {
	builtinKeybindings,
	DEFAULT_KEY_PLATFORM,
	isPrivileged,
	type KeyPlatform,
	type PrivilegedResolution,
	resolvePrivilegedKeys,
} from "../tui/keybindings.ts";
import { keyedRegistry } from "./chord.ts";
import type { TuiContext } from "./tui-context.ts";

type Awaitable<T> = T | Promise<T>;
export type TuiCommand = {
	title: string;
	/** Groups /hotkeys and the palette ("Session", "View", ...). */
	category?: string;
	/** Default keys for plugin ids. Ids from pi's built-in table (`app.*`) always use pi's defaults. */
	keys?: KeyId | KeyId[];
	/** Boolean context expression, e.g. "chat && editorEmpty && !overlay". More terms = more specific. */
	when?: string;
	slash?: {
		name: string;
		argumentHint?: string;
		complete?(prefix: string, ctx: TuiContext): Awaitable<AutocompleteItem[] | null>;
		/** Arguments complete on Tab only, never while typing (paths: Enter must submit what was typed). */
		tabOnly?: boolean;
	};
	/** Hidden from the palette (still in /hotkeys). */
	palette?: false;
	run(ctx: TuiContext, args?: string): void | Promise<void>;
};
/** Key = command id: pi ids where the semantics match, otherwise `<plugin>.<verb>`. */
export const TuiCommands = keyedRegistry<TuiCommand>("p2.tui-commands");

/** A slash name that is not a command: a prompt template (`name`) or a skill (`skill:name`). */
export type TuiSlashEntry = { name: string; description?: string; argumentHint?: string };
/**
 * More slash names for completion and for the editor's submit (10.8: templates and skills from the prompt plugin).
 * Commands always win: an entry with a command's slash name is neither listed nor expanded.
 */
export type TuiSlashSource = {
	entries(ctx: TuiContext): readonly TuiSlashEntry[];
	/** The text to send instead of `text` (`/name args`), or undefined to leave it as typed. */
	expand(ctx: TuiContext, text: string): Promise<string | undefined>;
};
export const TuiSlashSources = keyedRegistry<TuiSlashSource>("p2.tui-slash-sources");

// ---------------------------------------------------------------------------------------------------------------
// `when` grammar: or := and ("||" and)*; and := unary ("&&" unary)*; unary := "!" unary | "(" or ")" | term

export type WhenExpr =
	| { kind: "true" }
	| { kind: "term"; name: string }
	| { kind: "not"; expr: WhenExpr }
	| { kind: "and" | "or"; items: WhenExpr[] };
export type ParsedWhen = { expr: WhenExpr; terms: string[]; positive: Set<string>; specificity: number };

export function parseWhen(source: string | undefined): ParsedWhen {
	const terms: string[] = [];
	const positive = new Set<string>();
	if (!source?.trim()) return { expr: { kind: "true" }, terms, positive, specificity: 0 };
	const tokens = source.match(/\|\||&&|!|\(|\)|[A-Za-z][\w:.-]*|\S/g) ?? [];
	let index = 0;
	const peek = () => tokens[index];
	const parseOr = (negated: boolean): WhenExpr => {
		const items = [parseAnd(negated)];
		while (peek() === "||") {
			index++;
			items.push(parseAnd(negated));
		}
		return items.length === 1 ? items[0]! : { kind: "or", items };
	};
	const parseAnd = (negated: boolean): WhenExpr => {
		const items = [parseUnary(negated)];
		while (peek() === "&&") {
			index++;
			items.push(parseUnary(negated));
		}
		return items.length === 1 ? items[0]! : { kind: "and", items };
	};
	const parseUnary = (negated: boolean): WhenExpr => {
		const token = tokens[index++];
		if (token === "!") return { kind: "not", expr: parseUnary(!negated) };
		if (token === "(") {
			const expr = parseOr(negated);
			if (tokens[index++] !== ")") throw new Error(`Invalid when "${source}": missing )`);
			return expr;
		}
		if (!token || !/^[A-Za-z]/.test(token)) throw new Error(`Invalid when "${source}"`);
		terms.push(token);
		if (!negated) positive.add(token);
		return { kind: "term", name: token };
	};
	const expr = parseOr(false);
	if (index !== tokens.length) throw new Error(`Invalid when "${source}"`);
	return { expr, terms: [...new Set(terms)], positive, specificity: terms.length };
}

export function evaluateWhen(expr: WhenExpr, active: ReadonlySet<string>): boolean {
	switch (expr.kind) {
		case "true":
			return true;
		case "term":
			return active.has(expr.name);
		case "not":
			return !evaluateWhen(expr.expr, active);
		case "and":
			return expr.items.every((item) => evaluateWhen(item, active));
		case "or":
			return expr.items.some((item) => evaluateWhen(item, active));
	}
}

/** Whether both expressions can hold at once, given groups of mutually exclusive terms (screens, roles). */
export function canOverlap(a: ParsedWhen, b: ParsedWhen, exclusive: readonly (readonly string[])[] = []): boolean {
	const terms = [...new Set([...a.terms, ...b.terms])];
	if (terms.length > 12) return true;
	for (let mask = 0; mask < 1 << terms.length; mask++) {
		const active = new Set(terms.filter((_term, bit) => mask & (1 << bit)));
		if (exclusive.some((group) => group.filter((term) => active.has(term)).length > 1)) continue;
		if (evaluateWhen(a.expr, active) && evaluateWhen(b.expr, active)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------------

export type TuiCommandConflict = {
	kind: "privileged" | "transcript" | "command" | "slash" | "invalid";
	message: string;
};
type Entry = {
	id: string;
	command: TuiCommand;
	when: ParsedWhen;
	order: number;
	userBound: boolean;
	slash: string | undefined;
};
/** Transcript keys pi-tui's alt screen consumes before the focused component (stage 2), unless an overlay defers. */
const TRANSCRIPT_KEYS = [
	"tui.altScreen.search",
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
] as const;
const COMMAND_ID = /^[a-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/;
const SLASH_NAME = /^[a-z][\w:-]{0,39}$/;
const keyList = (keys: KeyId | readonly KeyId[] | undefined): KeyId[] =>
	keys === undefined ? [] : Array.isArray(keys) ? [...keys] : [keys as KeyId];

export class TuiCommandDispatcher {
	private table: ReadonlyMap<string, TuiCommand> = new Map();
	private user: KeybindingsConfig = {};
	private platform: KeyPlatform = DEFAULT_KEY_PLATFORM;
	private overrides: KeybindingDefinitions = {};
	private entries: Entry[] = [];
	private slashIndex = new Map<string, Entry>();
	private keymap: KeybindingsManager;
	conflicts: TuiCommandConflict[] = [];
	privileged: PrivilegedResolution = { keys: {}, lost: [] };
	/** Unknown ids in user keybindings: kept (pi does), reported in /hotkeys. */
	unknown: string[] = [];
	readonly autocomplete: AutocompleteProvider;
	private readonly options: {
		ctx(): TuiContext;
		contexts(): ReadonlySet<string>;
		exclusive(): readonly (readonly string[])[];
		onError(error: unknown): void;
		onRebuild?(): void;
	};
	constructor(options: TuiCommandDispatcher["options"]) {
		this.options = options;
		this.keymap = new KeybindingsManager(builtinKeybindings(this.platform));
		this.autocomplete = new SlashCompletion(this);
		this.rebuild();
	}
	get manager(): KeybindingsManager {
		return this.keymap;
	}
	matches(data: string, id: string): boolean {
		return this.keymap.matches(data, id as Keybinding);
	}
	getKeys(id: string): KeyId[] {
		return this.keymap.getKeys(id as Keybinding);
	}
	private sources: ReadonlyMap<string, TuiSlashSource> = new Map();
	setSources(table: ReadonlyMap<string, TuiSlashSource>): void {
		this.sources = table;
	}
	/** Template and skill names (not shadowing a command) with their source. */
	slashEntries(): { entry: TuiSlashEntry; source: TuiSlashSource }[] {
		const ctx = this.options.ctx();
		const taken = new Set(this.slashIndex.keys());
		return [...this.sources.values()].flatMap((source) =>
			source
				.entries(ctx)
				.filter((entry) => !taken.has(entry.name))
				.map((entry) => ({ entry, source })),
		);
	}
	/** Expands `/name args` through the source that lists `name`; other text (and commands) come back unchanged. */
	async expand(text: string): Promise<string> {
		const name = /^\/(\S+)/.exec(text)?.[1];
		const match = name ? this.slashEntries().find(({ entry }) => entry.name === name) : undefined;
		if (!match) return text;
		return (await match.source.expand(this.options.ctx(), text)) ?? text;
	}
	setCommands(table: ReadonlyMap<string, TuiCommand>): void {
		this.table = table;
		this.rebuild();
	}
	setUserBindings(user: KeybindingsConfig, platform: KeyPlatform = this.platform): void {
		this.user = user;
		this.platform = platform;
		this.rebuild();
	}
	/** Runtime overrides of built-in definitions (e.g. keys the current layout handles itself). */
	setOverrides(overrides: KeybindingDefinitions): void {
		this.overrides = overrides;
		this.rebuild();
	}

	/** Builds a fresh keymap (section 6.3 "Keymap rebuild"), the dispatch order and the reports. */
	private rebuild(): void {
		const builtin = { ...builtinKeybindings(this.platform), ...this.overrides };
		const conflicts: TuiCommandConflict[] = [];
		this.privileged = resolvePrivilegedKeys(builtin, this.user);
		for (const { id, key, to } of this.privileged.lost)
			conflicts.push({ kind: "privileged", message: `${key}: ${to} takes it from launcher action ${id}` });
		const privilegedKeys = new Set(Object.values(this.privileged.keys).flat());
		const definitions: KeybindingDefinitions = { ...builtin };
		const accepted: [string, TuiCommand, ParsedWhen][] = [];
		for (const [id, command] of this.table) {
			let when: ParsedWhen;
			try {
				if (!COMMAND_ID.test(id) || id.startsWith("tui.") || isPrivileged(id))
					throw new Error(`Invalid command id ${id}: tui.* and launcher ids are reserved`);
				when = parseWhen(command.when);
			} catch (error) {
				conflicts.push({ kind: "invalid", message: error instanceof Error ? error.message : String(error) });
				continue;
			}
			if (!(id in builtin)) {
				const defaults = keyList(command.keys);
				const kept = defaults.filter((key) => !privilegedKeys.has(key));
				for (const key of defaults.filter((key) => privilegedKeys.has(key)))
					conflicts.push({ kind: "privileged", message: `${key}: launcher-owned; dropped from ${id}'s defaults` });
				definitions[id] = { defaultKeys: kept, description: command.title };
			}
			accepted.push([id, command, when]);
		}
		this.keymap = new KeybindingsManager(definitions, this.user);
		setKeybindings(this.keymap);
		this.unknown = Object.keys(this.user).filter((id) => !(id in definitions));
		const transcript = new Map<KeyId, string>();
		for (const id of TRANSCRIPT_KEYS) for (const key of this.getKeys(id)) transcript.set(key, id);
		this.entries = accepted.map(([id, command, when], order) => ({
			id,
			command,
			when,
			order,
			userBound: this.user[id] !== undefined,
			slash: undefined,
		}));
		const byKey = new Map<KeyId, Entry[]>();
		for (const entry of this.entries)
			for (const key of this.getKeys(entry.id)) {
				if (!entry.when.positive.has("overlay") && transcript.has(key))
					conflicts.push({
						kind: "transcript",
						message: `${key}: ${transcript.get(key)} (transcript) wins over ${entry.id}`,
					});
				byKey.set(key, [...(byKey.get(key) ?? []), entry]);
			}
		this.entries.sort(
			(a, b) =>
				b.when.specificity - a.when.specificity || Number(b.userBound) - Number(a.userBound) || a.order - b.order,
		);
		const exclusive = this.options.exclusive();
		for (const [key, claimants] of byKey)
			for (let i = 0; i < claimants.length; i++)
				for (let j = i + 1; j < claimants.length; j++) {
					const [a, b] = [claimants[i]!, claimants[j]!];
					if (a.when.specificity !== b.when.specificity || !canOverlap(a.when, b.when, exclusive)) continue;
					if (a.userBound !== b.userBound) continue;
					conflicts.push({
						kind: "command",
						message: `${key}: ${a.id} and ${b.id}; ${a.id} wins (registered first)`,
					});
				}
		this.slashIndex = new Map();
		for (const entry of [...this.entries].sort((a, b) => a.order - b.order)) {
			const name = entry.command.slash?.name;
			if (!name) continue;
			if (!SLASH_NAME.test(name)) {
				conflicts.push({ kind: "slash", message: `/${name.slice(0, 40)} of ${entry.id} is not a valid name` });
				continue;
			}
			const holder = this.slashIndex.get(name);
			if (holder) {
				conflicts.push({ kind: "slash", message: `/${name}: ${holder.id} keeps it; disabled for ${entry.id}` });
				continue;
			}
			entry.slash = name;
			this.slashIndex.set(name, entry);
		}
		this.conflicts = conflicts;
		this.options.onRebuild?.();
	}

	private applicable(entry: Entry, active: ReadonlySet<string>): boolean {
		// While an overlay has focus, only commands that name it (or `overlay`) run before it (stage 3).
		if (
			active.has("overlay") &&
			![...entry.when.positive].some((term) => term === "overlay" || term.startsWith("overlay:"))
		)
			return false;
		return evaluateWhen(entry.when.expr, active);
	}

	/** Stages 3-4: the first applicable command bound to `data` consumes it. */
	dispatch(data: string, active: ReadonlySet<string> = this.options.contexts()): boolean {
		for (const entry of this.entries) {
			if (!this.matches(data, entry.id) || !this.applicable(entry, active)) continue;
			this.execute(entry);
			return true;
		}
		return false;
	}
	run(id: string, args?: string, active: ReadonlySet<string> = this.options.contexts()): boolean {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry || !evaluateWhen(entry.when.expr, active)) return false;
		this.execute(entry, args);
		return true;
	}
	runSlash(text: string, active: ReadonlySet<string> = this.options.contexts()): boolean {
		const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		const entry = match ? this.slashIndex.get(match[1]!) : undefined;
		if (!entry || !evaluateWhen(entry.when.expr, active)) return false;
		this.execute(entry, match?.[2]?.trim() || undefined);
		return true;
	}
	private execute(entry: Entry, args?: string): void {
		try {
			void Promise.resolve(entry.command.run(this.options.ctx(), args)).catch((error: unknown) =>
				this.options.onError(error),
			);
		} catch (error) {
			this.options.onError(error);
		}
	}

	/** Commands applicable in `active`, for the palette, slash completion and /hotkeys. */
	list(active?: ReadonlySet<string>): { id: string; command: TuiCommand; keys: KeyId[]; slash?: string }[] {
		return [...this.entries]
			.sort((a, b) => a.order - b.order)
			.filter((entry) => !active || evaluateWhen(entry.when.expr, active))
			.map((entry) => ({ id: entry.id, command: entry.command, keys: this.getKeys(entry.id), slash: entry.slash }));
	}
	slashEntry(name: string): { id: string; command: TuiCommand } | undefined {
		const entry = this.slashIndex.get(name);
		return entry && { id: entry.id, command: entry.command };
	}
	contexts(): ReadonlySet<string> {
		return this.options.contexts();
	}
	context(): TuiContext {
		return this.options.ctx();
	}
}

/** `/name` and argument completion fed by the registry (never pi's fs-reading CombinedAutocompleteProvider). */
class SlashCompletion implements AutocompleteProvider {
	private dispatcher: TuiCommandDispatcher;
	constructor(dispatcher: TuiCommandDispatcher) {
		this.dispatcher = dispatcher;
	}
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (cursorLine !== 0 || !before.startsWith("/")) return null;
		const space = before.indexOf(" ");
		// Tab (forced) completes arguments only; command names complete while typing.
		if (options.force && space === -1) return null;
		const active = this.dispatcher.contexts();
		if (space === -1) {
			const items = this.dispatcher
				.list(active)
				.filter((item) => item.slash)
				.map((item) => {
					const hint = item.command.slash?.argumentHint;
					return {
						value: item.slash!,
						label: item.slash!,
						description: hint ? `${hint} — ${item.command.title}` : item.command.title,
					};
				});
			// Templates and skills after the commands; pi matches `skill:` names by their bare name first.
			const extra = this.dispatcher.slashEntries().map(({ entry }) => ({
				value: entry.name,
				label: entry.name,
				description: entry.argumentHint
					? `${entry.argumentHint} — ${entry.description ?? ""}`
					: (entry.description ?? ""),
			}));
			const query = before.slice(1);
			const bare = fuzzyFilter(extra, query, (item) =>
				item.value.startsWith("skill:") ? item.value.slice("skill:".length) : item.value,
			);
			const full = fuzzyFilter(
				extra.filter((item) => item.value.startsWith("skill:") && !bare.includes(item)),
				query,
				(item) => item.value,
			);
			const filtered = [...fuzzyFilter(items, query, (item) => item.value), ...bare, ...full];
			return filtered.length ? { items: filtered, prefix: before } : null;
		}
		const entry = this.dispatcher.slashEntry(before.slice(1, space));
		const complete = entry?.command.slash?.complete;
		if (!complete || (entry?.command.slash?.tabOnly && !options.force)) return null;
		const argument = before.slice(space + 1);
		const items = await complete(argument, this.dispatcher.context());
		return items?.length && !options.signal.aborted ? { items, prefix: argument } : null;
	}
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const next = [...lines];
		if (prefix.startsWith("/") && before.trim() === "") {
			next[cursorLine] = `${before}/${item.value} ${after}`;
			return { lines: next, cursorLine, cursorCol: before.length + item.value.length + 2 };
		}
		next[cursorLine] = `${before}${item.value}${after}`;
		return { lines: next, cursorLine, cursorCol: before.length + item.value.length };
	}
}
