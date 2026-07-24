import { type Static, Type } from "typebox";
import type { AgentHarnessTool, FileError } from "../types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args as EditToolInput;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

function editAccessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

export function createEditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof editSchema,
	EditToolDetails | undefined
> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, { env }) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = await resolveToolPath(env, path, signal);
			return withFileMutationQueue(env, absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const info = await env.fileInfo(absolutePath, signal);
				if (!info.ok) throw editAccessError(path, info.error);
				if (info.value.kind !== "file" && info.value.kind !== "symlink") {
					throw new Error(`Could not edit file: ${path}. Path is not a file.`);
				}

				const readResult = await env.readTextFile(absolutePath, signal);
				if (!readResult.ok) throw editAccessError(path, readResult.error);
				if (signal?.aborted) throw new Error("Operation aborted");

				const { bom, text: content } = stripBom(readResult.value);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				if (signal?.aborted) throw new Error("Operation aborted");

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				const writeResult = await env.writeFile(absolutePath, finalContent, signal);
				if (!writeResult.ok) throw editAccessError(path, writeResult.error);
				if (signal?.aborted) throw new Error("Operation aborted");

				const diffResult = generateDiffString(baseContent, newContent);
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
					details: {
						diff: diffResult.diff,
						patch: generateUnifiedPatch(path, baseContent, newContent),
						firstChangedLine: diffResult.firstChangedLine,
					},
				};
			});
		},
	};
}
