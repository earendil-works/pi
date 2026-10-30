// Stack traces of plugin scripts (slice 7c §3, decision Q1 (b)): `vm.Script` maps no positions through a source map, so
// every evaluated script registers its map under its filename while something of its evaluation lives (its facet, or
// the error it threw while evaluated), and `mapStack` rewrites an error's stack through them, for the app's reporters.
// Nothing global: no `Error.prepareStackTrace`, no process-wide source-map switch. The registry is a module-level `Map`
// keyed by filename, not a `WeakMap` keyed by an owner: `mapStack` starts from a stack's text, which names only the
// filename. Its entries go with the last evaluation of their script (a `FinalizationRegistry` counts them down).

import { SourceMap } from "node:module";
import { basename, join } from "node:path";

/** A registered script: how its positions map, its plugin's directory, and how many of its evaluations live. */
type Registered = { readonly map: SourceMap; readonly dir: string; live: number };

/** The evaluated scripts by filename, while an evaluation of each lives. */
const scripts = new Map<string, Registered>();

/** Counts down an evaluation that was collected; its script's entry goes with the last one. */
const collected = new FinalizationRegistry<string>((filename) => {
	const script = scripts.get(filename);
	if (script !== undefined && --script.live === 0) scripts.delete(filename);
});

/**
 * Registers the script `source` evaluated under `filename` for plugin directory `dir` while `owner` (its facet, or the
 * error its evaluation threw) lives: its inline source map, whose sources are relative to the plugin's directory. Two
 * evaluations of one script (two hosts) share the entry.
 */
export function registerScript(filename: string, source: string, dir: string, owner: object): void {
	let script = scripts.get(filename);
	if (script === undefined) {
		const map = inlineSourceMap(source);
		if (map === undefined) return;
		script = { map, dir, live: 0 };
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
		const entry = script?.map.findEntry(Number(line) - 1, Number(column) - 1);
		if (script === undefined || entry === undefined || !("originalSource" in entry)) return whole;
		const file = join(basename(script.dir), entry.originalSource).split("\\").join("/");
		return `${file}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
	});
}

/** A position in a stack line: `filename:line:column`, the filename being anything up to it (spaces included). */
const POSITION = /([^\s()]+):(\d+):(\d+)/g;
