// Stack traces of plugin scripts (slice 7c §3, decision Q1 (b)): `vm.Script` maps no positions through a source map, so
// every evaluated script registers its source under its filename while something of its evaluation lives (its facet, or
// the error it threw while evaluated), and `mapStack` rewrites an error's stack through their maps, for the app's
// reporters. A script's map is parsed at the first position looked up in it: parsed at registration, the maps of a p2
// session worker's 30 facets took about 7 MiB of its heap for its life, and most workers never map a stack.
// Nothing global: no `Error.prepareStackTrace`, no process-wide source-map switch. The registry is a module-level `Map`
// keyed by filename, not a `WeakMap` keyed by an owner: `mapStack` starts from a stack's text, which names only the
// filename. Its entries go with the last evaluation of their script (a `FinalizationRegistry` counts them down).

import { SourceMap } from "node:module";
import { basename, join } from "node:path";

/** A registered script: its source and map, its plugin's directory, and how many of its evaluations live. */
type Registered = { readonly source: string; map: ScriptMap; readonly dir: string; live: number };

/** A registered script's map: not parsed yet, or parsed (`undefined`: the script has none). */
type ScriptMap = { readonly kind: "unparsed" } | { readonly kind: "parsed"; readonly map: SourceMap | undefined };

/** The evaluated scripts by filename, while an evaluation of each lives. */
const scripts = new Map<string, Registered>();

/** Counts down an evaluation that was collected; its script's entry goes with the last one. */
const collected = new FinalizationRegistry<string>((filename) => {
	const script = scripts.get(filename);
	if (script !== undefined && --script.live === 0) scripts.delete(filename);
});

/**
 * Registers the script `source` evaluated under `filename` for plugin directory `dir` while `owner` (its facet, or the
 * error its evaluation threw) lives: its inline source map, whose sources are relative to the plugin's directory, is
 * parsed when `mapStack` first looks up a position in it. Two evaluations of one script (two hosts) share the entry.
 */
export function registerScript(filename: string, source: string, dir: string, owner: object): void {
	let script = scripts.get(filename);
	if (script === undefined) {
		// The evaluated script holds `source` already (V8 keeps a script's source): the entry adds no copy.
		script = { source, map: { kind: "unparsed" }, dir, live: 0 };
		scripts.set(filename, script);
	}
	script.live++;
	collected.register(owner, filename);
}

/** The inline source map esbuild appended to a built script, if it has one. */
export function inlineSourceMap(source: string): SourceMap | undefined {
	const inline = SOURCE_MAP.exec(source);
	return inline === null ? undefined : new SourceMap(JSON.parse(Buffer.from(inline[1]!, "base64").toString("utf8")));
}

/** The inline source map esbuild appends to a script. */
const SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * `error`'s stack with every position in a registered plugin script mapped through its source map to the plugin's file
 * and line (`notes/worker.ts:12:3`: the plugin's directory name and the file's path inside it); other lines as they
 * are. A value that is no error with a stack gives its string.
 */
export function mapStack(error: unknown): string {
	const stack = error instanceof Error ? error.stack : undefined;
	if (stack === undefined) return String(error);
	return stack.replace(POSITION, (whole, filename: string, line: string, column: string) => {
		const script = scripts.get(filename);
		if (script === undefined) return whole;
		const entry = mapOf(script)?.findEntry(Number(line) - 1, Number(column) - 1);
		if (entry === undefined || !("originalSource" in entry)) return whole;
		const file = join(basename(script.dir), entry.originalSource).split("\\").join("/");
		return `${file}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
	});
}

/** `script`'s source map, parsed at its first use. */
function mapOf(script: Registered): SourceMap | undefined {
	if (script.map.kind === "unparsed") script.map = { kind: "parsed", map: inlineSourceMap(script.source) };
	return script.map.map;
}

/** A position in a stack line: `filename:line:column`, the filename being anything up to it (spaces included). */
const POSITION = /([^\s()]+):(\d+):(\d+)/g;
