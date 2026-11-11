import { type Static, Type } from "typebox";
import { createSearchJob } from "../../utils/native-search.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getOutputArtifacts } from "../output-artifacts.ts";
import { grepRenderers } from "./renderers/grep.ts";
import { recursiveBasenameGlob, resolveSearchScope, searchResultPath } from "./search-scope.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead, truncateLine } from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({
		description:
			"Regex pattern; lookaround and backreferences automatically use PCRE2. Use \\n for multiline search.",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"File, directory, or glob; separate multiple scopes with semicolons. Prefix exclusions with !. Files accept :start-end line ranges. Defaults to cwd.",
		}),
	),
	glob: Type.Optional(
		Type.String({ description: "Additional file glob filter, e.g. '*.ts'; prefix ! to exclude matching paths" }),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat the pattern literally (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Lines before and after matches. Omitted: 1 before, 3 after." })),
	limit: Type.Optional(
		Type.Number({
			description:
				"Maximum matches on this page. Default: up to 20 per file across 20 files; 200 for a single file.",
		}),
	),
	gitignore: Type.Optional(
		Type.Boolean({ description: "Respect ignore files during directory scans (default: true)" }),
	),
	skip: Type.Optional(
		Type.Number({ description: "Matching-file offset for pagination (default: 0). Ignored for a single file." }),
	),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents with regex, context, and file pagination (respects .gitignore)",
	guidelines: ["Prefer grep over shell commands for searching file contents."],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	matchCount?: number;
	files?: string[];
	missingPaths?: string[];
}

/** Optional directory classification. Remote search requires overriding execute(), not this local backend. */
export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
}

export interface GrepToolOptions {
	operations?: GrepOperations;
}

/** Search local contents through the Rust addon and return a balanced page of matching files. */
export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents using native Rust regex with automatic PCRE2 fallback. Accepts multiple paths/globs, exclusions, and file line ranges. Defaults to 20 files with 20 matches per file, or 200 matches for one file. Includes context and match-centered long-line windows. Input buffering is limited to 64 MiB; multiline searches buffer the file. Use skip for subsequent file pages. Oversized returned search pages are retained as session artifacts.",
		promptSnippet: grepToolSystemPromptContribution.snippet,
		promptGuidelines: [...grepToolSystemPromptContribution.guidelines],
		parameters: grepSchema,
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			if (!args.pattern.length) throw new Error("Pattern must not be empty");
			const skip = Math.floor(args.skip ?? 0);
			if (!Number.isFinite(skip) || skip < 0 || skip > 0xffffffff)
				throw new Error("Skip must be a non-negative 32-bit integer");
			signal?.throwIfAborted();
			const scope = await resolveSearchScope(ctx?.cwd || cwd, args.path, "grep");
			if (options?.operations && scope.targets.length === 1) {
				scope.singleFile = !(await options.operations.isDirectory(scope.targets[0].path));
			}
			const matchLimit = Math.max(1, Math.min(0xffffffff, Math.floor(args.limit ?? 2000)));
			const perFileLimit = scope.singleFile ? Math.min(matchLimit, args.limit === undefined ? 200 : matchLimit) : 20;
			const context =
				args.context === undefined ? undefined : Math.max(0, Math.min(0xffffffff, Math.floor(args.context)));
			const { job, dispose } = createSearchJob(signal);
			try {
				const result = await job.grep({
					targets: scope.targets,
					exclusions: scope.exclusions,
					pattern: args.pattern,
					glob: args.glob?.startsWith("!")
						? `!${recursiveBasenameGlob(args.glob.slice(1))}`
						: args.glob
							? recursiveBasenameGlob(args.glob)
							: undefined,
					ignoreCase: args.ignoreCase ?? false,
					literal: args.literal ?? false,
					gitignore: args.gitignore ?? true,
					contextBefore: context ?? 1,
					contextAfter: context ?? 3,
					perFileLimit,
					matchLimit,
					fileLimit: scope.singleFile ? 1 : 20,
					skip: scope.singleFile ? 0 : skip,
				});
				signal?.throwIfAborted();
				const details: GrepToolDetails = {};
				const notices: string[] = [];
				const paths = result.files.map((file) => searchResultPath(file.path, scope.basePath));
				const outputLines: string[] = [];
				// Round-robin files so a long early file cannot consume the entire output byte budget.
				for (let row = 0; ; row++) {
					let emitted = false;
					for (let index = 0; index < result.files.length; index++) {
						const line = result.files[index].lines[row];
						if (!line) continue;
						emitted = true;
						const prefix = line.isMatch ? `${paths[index]}:${line.number}: ` : `${paths[index]}-${line.number}- `;
						outputLines.push(`${prefix}${line.text}${line.column === undefined ? "" : ` [col ${line.column}]`}`);
					}
					if (!emitted) break;
				}
				if (result.files.length) {
					details.matchCount = result.files.reduce((total, file) => total + file.matchCount, 0);
					details.files = paths;
				}
				if (result.fileLimitReached) {
					details.fileLimitReached = 20;
					notices.push(`20 files limit reached. Use skip=${skip + result.files.length} for the next page`);
				}
				if (result.matchLimitReached) {
					details.matchLimitReached = matchLimit;
					notices.push(
						`${matchLimit} matches limit reached. Use limit=${matchLimit * 2} for more, or refine pattern`,
					);
				}
				const capped = paths.filter((_path, index) => result.files[index].limitReached);
				if (capped.length && !result.matchLimitReached) {
					details.perFileLimitReached = perFileLimit;
					notices.push(
						`More than ${perFileLimit} matches per file in ${formatNoticePaths(capped)}. Search one file alone or narrow its line range`,
					);
				}
				if (result.files.some((file) => file.linesTruncated)) {
					details.linesTruncated = true;
					notices.push("Long lines show a window around the first match; [col N] is its original column");
				}
				if (scope.missingPaths.length) {
					details.missingPaths = scope.missingPaths;
					notices.push(`Skipped missing paths: ${formatNoticePaths(scope.missingPaths)}`);
				}
				if (result.skippedFiles) {
					notices.push(
						`Skipped ${result.skippedFiles} files that could not be searched (unreadable or input-buffer limit exceeded)`,
					);
				}
				const rawOutput =
					outputLines.join("\n") || (skip && !scope.singleFile ? "No more results" : "No matches found");
				let suffix = notices.length ? `\n\n[${notices.join(". ")}]` : "";
				if (ctx && getOutputArtifacts(ctx.sessionManager)) {
					return {
						content: [{ type: "text", text: rawOutput + suffix }],
						details: Object.keys(details).length ? details : undefined,
					};
				}
				let truncation = truncateHead(rawOutput, {
					maxLines: Number.MAX_SAFE_INTEGER,
					maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix),
				});
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					suffix = `\n\n[${notices.join(". ")}]`;
					truncation = truncateHead(rawOutput, {
						maxLines: Number.MAX_SAFE_INTEGER,
						maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix),
					});
					if (result.files.length) {
						truncation.totalLines = result.files.reduce((total, file) => total + file.outputLines, 0);
						truncation.totalBytes = result.files.reduce(
							(total, file, index) =>
								total +
								file.contentBytes +
								file.numberBytes +
								(Buffer.byteLength(paths[index]) + 4) * file.outputLines,
							-1,
						);
					}
					details.truncation = truncation;
				}
				return {
					content: [{ type: "text", text: truncation.content + suffix }],
					details: Object.keys(details).length ? details : undefined,
				};
			} finally {
				dispose();
			}
		},
		...grepRenderers,
	};
}

/** Create the agent-facing wrapper for native content search. */
export function createGrepTool(cwd: string, options?: GrepToolOptions): TypeBoxAgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}

// Keep path-bearing notices bounded while reserving their actual bytes from the output budget.
function formatNoticePaths(paths: string[]): string {
	const shown = paths
		.slice(0, 3)
		.map((path) => truncateLine(path, 120).text)
		.join(", ");
	return paths.length > 3 ? `${shown}, ... (${paths.length} total)` : shown;
}
