import path from "node:path";
import { type Static, Type } from "typebox";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { createSearchJob } from "../../utils/native-search.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getOutputArtifacts } from "../output-artifacts.ts";
import { resolveToCwd } from "./path-utils.ts";
import { findRenderers } from "./renderers/find.ts";
import { recursiveBasenameGlob, resolveSearchScope } from "./search-scope.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: path.PlatformPath = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.Optional(
		Type.String({
			description: "Glob filter, e.g. '*.ts' or 'src/**/*.spec.ts'. Omitted: all paths in the supplied scopes.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Directory, file, or glob. Separate multiple scopes with semicolons; prefix exclusions with !. Defaults to cwd.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum returned paths (default: 200), newest modified first" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files (default: true)" })),
	gitignore: Type.Optional(
		Type.Boolean({ description: "Respect ignore files during directory scans (default: true)" }),
	),
});

export const findToolSystemPromptContribution = {
	snippet: "Find paths by glob across files and directories (respects .gitignore)",
	guidelines: ["Prefer find over shell commands for locating files by name or glob."],
} as const;

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	missingPaths?: string[];
}

/** Pluggable file discovery for extensions that delegate searches to remote systems. */
export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (
		pattern: string,
		cwd: string,
		options: { ignore: string[]; limit: number; hidden?: boolean; gitignore?: boolean; signal?: AbortSignal },
	) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** Custom remote operations; the built-in local backend uses the Rust addon. */
	operations?: FindOperations;
}

/** Find paths through the shared native traversal, or an explicitly supplied remote adapter. */
export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	return {
		name: "find",
		label: "find",
		description:
			"Find paths by glob using native Rust traversal. Accepts multiple scopes and !exclusions. Bare '*.ts' searches recursively; 'src/*.ts' matches direct children. Respects .gitignore, includes hidden files, and returns the newest 200 paths by default. Oversized selected results are retained as session artifacts.",
		promptSnippet: findToolSystemPromptContribution.snippet,
		promptGuidelines: [...findToolSystemPromptContribution.guidelines],
		parameters: findSchema,
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const effectiveCwd = ctx?.cwd || cwd;
			const limit = Math.max(1, Math.min(0xfffffffe, Math.floor(args.limit ?? 200)));
			const pattern = args.pattern ?? "**/*";
			if (!pattern.trim()) throw new Error("Glob pattern must not be empty");
			let results: string[];
			let resultLimitReached: boolean;
			let missingPaths: string[] = [];
			if (options?.operations) {
				const searchPath = resolveToCwd(args.path || ".", effectiveCwd);
				if (!(await raceWithAbortSignal(Promise.resolve(options.operations.exists(searchPath)), signal)))
					throw new Error(`Path not found: ${searchPath}`);
				signal?.throwIfAborted();
				const paths = await raceWithAbortSignal(
					Promise.resolve(
						options.operations.glob(pattern, searchPath, {
							ignore: ["**/node_modules/**", "**/.git/**"],
							limit: limit + 1,
							hidden: args.hidden ?? true,
							gitignore: args.gitignore ?? true,
							signal,
						}),
					),
					signal,
				);
				signal?.throwIfAborted();
				resultLimitReached = paths.length > limit;
				results = paths.slice(0, limit).map((file) => relativizeFindResultPath(file, searchPath));
			} else {
				const scope = await resolveSearchScope(effectiveCwd, args.path, "find");
				missingPaths = scope.missingPaths;
				const { job, dispose } = createSearchJob(signal);
				try {
					const result = await job.glob({
						targets: scope.targets,
						exclusions: scope.exclusions,
						pattern: recursiveBasenameGlob(pattern),
						hidden: args.hidden ?? true,
						gitignore: args.gitignore ?? true,
						limit,
					});
					signal?.throwIfAborted();
					results = result.paths.map((file) =>
						relativizeFindResultPath(file, scope.singleFile ? path.dirname(scope.basePath) : scope.basePath),
					);
					resultLimitReached = result.limitReached;
				} finally {
					dispose();
				}
			}
			const rawOutput = results.join("\n");
			const truncation =
				ctx && getOutputArtifacts(ctx.sessionManager)
					? undefined
					: truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			const details: FindToolDetails = {};
			const notices: string[] = [];
			if (resultLimitReached) {
				details.resultLimitReached = limit;
				notices.push(
					options?.operations
						? `${limit} results limit reached`
						: `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`,
				);
			}
			if (truncation?.truncated) {
				details.truncation = truncation;
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (missingPaths.length) {
				details.missingPaths = missingPaths;
				notices.push(`Skipped missing paths: ${missingPaths.join("; ")}`);
			}
			let output = (truncation?.content ?? rawOutput) || "No files found matching pattern";
			if (notices.length) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length ? details : undefined,
			};
		},
		...findRenderers,
	};
}

/** Create the agent-facing wrapper for native glob discovery. */
export function createFindTool(cwd: string, options?: FindToolOptions): TypeBoxAgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
