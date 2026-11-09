// Typed Node-API boundary shared by the grep and find tools.
import { createRequire } from "node:module";
import { getNativeSearchPath } from "../config.ts";

export interface SearchTarget {
	path: string;
	glob?: string;
	ranges: { start: number; end: number }[];
}

export interface NativeGrepOptions {
	targets: SearchTarget[];
	exclusions: string[];
	pattern: string;
	glob?: string;
	ignoreCase: boolean;
	literal: boolean;
	gitignore: boolean;
	contextBefore: number;
	contextAfter: number;
	perFileLimit: number;
	matchLimit: number;
	fileLimit: number;
	skip: number;
}

export interface NativeMatchLine {
	number: number;
	text: string;
	isMatch: boolean;
	column?: number;
}

export interface NativeFileMatches {
	path: string;
	lines: NativeMatchLine[];
	matchCount: number;
	limitReached: boolean;
	linesTruncated: boolean;
	outputLines: number;
	contentBytes: number;
	numberBytes: number;
}

export interface NativeGrepResult {
	files: NativeFileMatches[];
	fileLimitReached: boolean;
	matchLimitReached: boolean;
	skippedFiles: number;
}

export interface NativeGlobOptions {
	targets: SearchTarget[];
	exclusions: string[];
	pattern: string;
	hidden: boolean;
	gitignore: boolean;
	limit: number;
}

interface SearchJob {
	cancel(): void;
	grep(options: NativeGrepOptions): Promise<NativeGrepResult>;
	glob(options: NativeGlobOptions): Promise<{ paths: string[]; limitReached: boolean }>;
}

interface SearchBinding {
	SearchJob: new () => SearchJob;
}

const require = createRequire(import.meta.url);
let binding: SearchBinding | undefined;

/** Load a per-operation native search job; never fall back to external executables. */
export function createSearchJob(signal?: AbortSignal): { job: SearchJob; dispose: () => void } {
	signal?.throwIfAborted();
	if (!binding) {
		const path = getNativeSearchPath();
		try {
			// The bundled addon owns this ABI; Node's require() has no typed native-module boundary.
			binding = require(path) as SearchBinding;
		} catch (cause) {
			throw new Error(
				`Cannot load native search at ${path}. From a source checkout, run npm run build:native:search. For an installed package, reinstall Pi for this platform.`,
				{ cause },
			);
		}
	}
	const job = new binding.SearchJob();
	const cancel = () => job.cancel();
	signal?.addEventListener("abort", cancel, { once: true });
	return { job, dispose: () => signal?.removeEventListener("abort", cancel) };
}
