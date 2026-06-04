import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const replacementSchema = Type.Object(
	{
		oldText: Type.String({ description: "Exact text to replace. Must appear exactly once in the original file." }),
		newText: Type.String({ description: "Replacement text." }),
	},
	{ additionalProperties: false },
);

const filePatchSchema = Type.Object(
	{
		path: Type.String({ description: "File path to patch, relative to cwd or absolute." }),
		replacements: Type.Array(replacementSchema, {
			description: "Exact text replacements to apply to this file. All oldText values are matched against the original file.",
		}),
	},
	{ additionalProperties: false },
);

const applyPatchSchema = Type.Object(
	{
		description: Type.Optional(Type.String({ description: "Short reason for the patch." })),
		patches: Type.Array(filePatchSchema, { description: "File patches to apply." }),
	},
	{ additionalProperties: false },
);

type ApplyPatchInput = Static<typeof applyPatchSchema>;
type FilePatchInput = Static<typeof filePatchSchema>;
type ReplacementInput = Static<typeof replacementSchema>;

interface HarnessLogEntry {
	version: 1;
	seq: number;
	timestamp: string;
	type:
		| "apply_patch_requested"
		| "apply_patch_approval_decision"
		| "file_mutation_started"
		| "file_mutation_completed"
		| "file_mutation_failed";
	payload: Record<string, unknown>;
}

interface AppliedFileResult {
	path: string;
	absolutePath: string;
	replacements: number;
	bytesBefore: number;
	bytesAfter: number;
}

interface FailedFileResult {
	path: string;
	absolutePath: string;
	error: string;
}

interface ApplyPatchDetails {
	description?: string;
	applied: AppliedFileResult[];
	failed: FailedFileResult[];
}

interface ReplacementRange {
	start: number;
	end: number;
	replacement: ReplacementInput;
}

const PROTECTED_SEGMENTS = new Set([".git", "node_modules"]);
const PROTECTED_BASENAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);

function prepareApplyPatchArguments(input: unknown): ApplyPatchInput {
	if (!input || typeof input !== "object") return input as ApplyPatchInput;
	const value = input as Record<string, unknown>;

	if (Array.isArray(value.patches)) return value as ApplyPatchInput;

	if (typeof value.path === "string" && Array.isArray(value.edits)) {
		return {
			description: typeof value.description === "string" ? value.description : undefined,
			patches: [
				{
					path: value.path,
					replacements: value.edits.filter(isReplacementInput),
				},
			],
		};
	}

	if (typeof value.path === "string" && typeof value.oldText === "string" && typeof value.newText === "string") {
		return {
			description: typeof value.description === "string" ? value.description : undefined,
			patches: [
				{
					path: value.path,
					replacements: [{ oldText: value.oldText, newText: value.newText }],
				},
			],
		};
	}

	return value as ApplyPatchInput;
}

function isReplacementInput(value: unknown): value is ReplacementInput {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.oldText === "string" && typeof candidate.newText === "string";
}

function normalizePathInput(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveTarget(cwd: string, path: string): { normalizedPath: string; absolutePath: string; isOutsideCwd: boolean } {
	const normalizedPath = normalizePathInput(path);
	const absolutePath = resolve(cwd, normalizedPath);
	const relativePath = relative(cwd, absolutePath);
	return {
		normalizedPath,
		absolutePath,
		isOutsideCwd: relativePath.startsWith("..") || isAbsolute(relativePath),
	};
}

function isProtectedPath(cwd: string, absolutePath: string): boolean {
	const relativePath = relative(cwd, absolutePath);
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	if (parts.some((part) => PROTECTED_SEGMENTS.has(part))) return true;
	const basename = parts[parts.length - 1];
	return basename !== undefined && PROTECTED_BASENAMES.has(basename);
}

function collectRanges(original: string, replacements: ReplacementInput[], path: string): ReplacementRange[] {
	if (replacements.length === 0) throw new Error(`No replacements provided for ${path}`);

	const ranges: ReplacementRange[] = [];
	for (const replacement of replacements) {
		if (replacement.oldText.length === 0) throw new Error(`Empty oldText is not allowed for ${path}`);
		const first = original.indexOf(replacement.oldText);
		if (first === -1) throw new Error(`oldText not found in ${path}`);
		const second = original.indexOf(replacement.oldText, first + replacement.oldText.length);
		if (second !== -1) throw new Error(`oldText is not unique in ${path}`);
		ranges.push({ start: first, end: first + replacement.oldText.length, replacement });
	}

	const sorted = [...ranges].sort((left, right) => left.start - right.start);
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1]!;
		const current = sorted[index]!;
		if (current.start < previous.end) throw new Error(`Overlapping replacements for ${path}`);
	}
	return sorted;
}

function applyRanges(original: string, ranges: ReplacementRange[]): string {
	let result = original;
	for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, range.start)}${range.replacement.newText}${result.slice(range.end)}`;
	}
	return result;
}

function groupPatches(patches: FilePatchInput[]): FilePatchInput[] {
	const grouped = new Map<string, ReplacementInput[]>();
	for (const patch of patches) {
		const existing = grouped.get(patch.path) ?? [];
		existing.push(...patch.replacements);
		grouped.set(patch.path, existing);
	}
	return [...grouped.entries()].map(([path, replacements]) => ({ path, replacements }));
}

function uniqueSortedPaths(paths: string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function withAllFileMutationQueues<T>(paths: string[], fn: () => Promise<T>, index = 0): Promise<T> {
	if (index >= paths.length) return fn();
	return withFileMutationQueue(paths[index]!, () => withAllFileMutationQueues(paths, fn, index + 1));
}

export default function (pi: ExtensionAPI) {
	let seq = 0;

	function appendLog(type: HarnessLogEntry["type"], payload: Record<string, unknown>): void {
		seq += 1;
		pi.appendEntry("codex-harness:event", {
			version: 1,
			seq,
			timestamp: new Date().toISOString(),
			type,
			payload,
		} satisfies HarnessLogEntry);
	}

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Apply exact text replacements to one or more files. Replacements are matched against each original file, must be unique, and are applied under a per-file mutation queue.",
		promptSnippet: "Apply exact text patches to files with mutation safety",
		promptGuidelines: [
			"Use apply_patch for multi-file exact text replacements when several files must change together.",
			"Every apply_patch oldText must match exactly once in the original file.",
			"Do not use apply_patch for generated files, secrets, .env files, node_modules, or .git internals unless explicitly approved.",
		],
		parameters: applyPatchSchema,
		executionMode: "sequential",
		prepareArguments: prepareApplyPatchArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const groupedPatches = groupPatches(params.patches);
			const targets = groupedPatches.map((patch) => {
				const resolved = resolveTarget(ctx.cwd, patch.path);
				return {
					patch,
					...resolved,
					isProtected: isProtectedPath(ctx.cwd, resolved.absolutePath),
				};
			});

			appendLog("apply_patch_requested", {
				toolCallId,
				description: params.description,
				cwd: ctx.cwd,
				targets: targets.map((target) => ({
					path: target.patch.path,
					absolutePath: target.absolutePath,
					replacements: target.patch.replacements.length,
					isOutsideCwd: target.isOutsideCwd,
					isProtected: target.isProtected,
				})),
			});

			const approvalReasons = targets
				.flatMap((target) => [
					target.isOutsideCwd ? `${target.patch.path} is outside cwd` : undefined,
					target.isProtected ? `${target.patch.path} is protected` : undefined,
				])
				.filter((reason): reason is string => reason !== undefined);

			if (approvalReasons.length > 0) {
				if (!ctx.hasUI) {
					appendLog("apply_patch_approval_decision", {
						toolCallId,
						decision: "denied",
						reasons: approvalReasons,
						source: "policy",
					});
					throw new Error(`apply_patch requires approval: ${approvalReasons.join("; ")}`);
				}

				const ok = await ctx.ui.confirm(
					"apply_patch requires approval",
					approvalReasons.join("\n"),
					{ signal },
				);
				appendLog("apply_patch_approval_decision", {
					toolCallId,
					decision: ok ? "approved" : "denied",
					reasons: approvalReasons,
					source: "user",
				});
				if (!ok) throw new Error("apply_patch denied by user");
			}

			const applied: AppliedFileResult[] = [];
			const sortedTargets = [...targets].sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));

			await withAllFileMutationQueues(
				uniqueSortedPaths(sortedTargets.map((target) => target.absolutePath)),
				async () => {
					const prepared: Array<{ target: (typeof sortedTargets)[number]; original: string; patched: string }> = [];

					for (const target of sortedTargets) {
						if (signal?.aborted) throw new Error("Operation aborted");
						appendLog("file_mutation_started", {
							toolCallId,
							path: target.patch.path,
							absolutePath: target.absolutePath,
							replacements: target.patch.replacements.length,
						});

						try {
							const original = await readFile(target.absolutePath, "utf8");
							if (signal?.aborted) throw new Error("Operation aborted");
							const ranges = collectRanges(original, target.patch.replacements, target.patch.path);
							prepared.push({ target, original, patched: applyRanges(original, ranges) });
						} catch (error) {
							const failedResult = {
								path: target.normalizedPath,
								absolutePath: target.absolutePath,
								error: error instanceof Error ? error.message : String(error),
							} satisfies FailedFileResult;
							appendLog("file_mutation_failed", { toolCallId, ...failedResult });
							throw new Error(`apply_patch failed for ${failedResult.path}: ${failedResult.error}`);
						}
					}

					for (const item of prepared) {
						try {
							await mkdir(dirname(item.target.absolutePath), { recursive: true });
							if (signal?.aborted) throw new Error("Operation aborted");
							await writeFile(item.target.absolutePath, item.patched, "utf8");
							if (signal?.aborted) throw new Error("Operation aborted");
							const result = {
								path: item.target.normalizedPath,
								absolutePath: item.target.absolutePath,
								replacements: item.target.patch.replacements.length,
								bytesBefore: Buffer.byteLength(item.original, "utf8"),
								bytesAfter: Buffer.byteLength(item.patched, "utf8"),
							} satisfies AppliedFileResult;
							applied.push(result);
							appendLog("file_mutation_completed", { toolCallId, ...result });
						} catch (error) {
							const failedResult = {
								path: item.target.normalizedPath,
								absolutePath: item.target.absolutePath,
								error: error instanceof Error ? error.message : String(error),
							} satisfies FailedFileResult;
							appendLog("file_mutation_failed", { toolCallId, ...failedResult });
							throw new Error(`apply_patch failed for ${failedResult.path}: ${failedResult.error}`);
						}
					}
				},
			);

			const details = { description: params.description, applied, failed: [] } satisfies ApplyPatchDetails;
			return {
				content: [
					{
						type: "text",
						text: `Applied ${applied.reduce((sum, entry) => sum + entry.replacements, 0)} replacement(s) across ${applied.length} file(s).`,
					},
				],
				details,
			};
		},
	});
}
