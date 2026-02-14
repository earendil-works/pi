import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { getToolDescription } from "../prompts/index.js";
import { type ApplyPatchParseResult, parseApplyPatchInput } from "./apply-patch/parse.js";
import { runApplyPatchBinary } from "./apply-patch/runner.js";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

function resolvePathLikeApplyPatchEngine(cwd: string, targetPath: string): string {
	const expanded = expandPath(targetPath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

type BeforeSnapshot = { exists: true; content: string | null } | { exists: false; content: null };

async function captureBeforeSnapshot(absolutePath: string): Promise<BeforeSnapshot> {
	try {
		const content = await readFile(absolutePath, "utf8");
		return { exists: true, content };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			return { exists: false, content: null };
		}
		// Unreadable file - proceed but undo may not be possible.
		return { exists: true, content: null };
	}
}

export type ApplyPatchUndoEntry =
	| {
			path: string;
			beforeExists: false;
			beforeContent: null;
			afterExists: true;
			afterContentHash: string;
	  }
	| {
			path: string;
			beforeExists: true;
			beforeContent: string | null;
			afterExists: true;
			afterContentHash: string;
	  }
	| {
			path: string;
			beforeExists: true;
			beforeContent: string | null;
			afterExists: false;
	  }
	| {
			path: string;
			beforeExists: false;
			beforeContent: null;
			afterExists: false;
	  };

export interface ApplyPatchToolDetails {
	parsed: ApplyPatchParseResult;
	undo: {
		entries: ApplyPatchUndoEntry[];
	};
}

interface ApplyPatchUndoEntryDraft {
	path: string;
	beforeExists: boolean;
	beforeContent: string | null;
	afterExists: boolean;
}

const applyPatchSchema = Type.Object({
	input: Type.String({ description: "The entire contents of the apply_patch command" }),
});

export const applyPatchTool: AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> = {
	name: "apply_patch",
	label: "apply_patch",
	description: getToolDescription("apply_patch"),
	parameters: applyPatchSchema,
	execute: async (
		_toolCallId: string,
		{ input }: { input: string },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const cwd = process.cwd();
		const parsed = parseApplyPatchInput(input);

		// Capture file state for /undo support.
		// We store full "before" snapshots and a hash of the "after" content.
		const undoEntries: ApplyPatchUndoEntryDraft[] = [];

		for (const op of parsed.ops) {
			const opPath = resolvePathLikeApplyPatchEngine(cwd, op.path);

			if (op.type === "add") {
				const before = await captureBeforeSnapshot(opPath);
				undoEntries.push({
					path: opPath,
					beforeExists: before.exists,
					beforeContent: before.content,
					afterExists: true,
				});
				continue;
			}

			if (op.type === "delete") {
				const before = await captureBeforeSnapshot(opPath);
				undoEntries.push({
					path: opPath,
					beforeExists: before.exists,
					beforeContent: before.content,
					afterExists: false,
				});
				continue;
			}

			// update
			const before = await captureBeforeSnapshot(opPath);
			if (before.exists && before.content === null) {
				throw new Error(`Failed to read file for undo: ${op.path}`);
			}

			// Handle Move-to updates: apply_patch engine treats "move to self" as regular update.
			const moveTarget = op.movedTo ? resolvePathLikeApplyPatchEngine(cwd, op.movedTo) : null;
			if (moveTarget && moveTarget !== opPath) {
				// Source is removed by the patch.
				undoEntries.push({
					path: opPath,
					beforeExists: before.exists,
					beforeContent: before.content,
					afterExists: false,
				});

				// Destination is created.
				const beforeDest = await captureBeforeSnapshot(moveTarget);
				undoEntries.push({
					path: moveTarget,
					beforeExists: beforeDest.exists,
					beforeContent: beforeDest.content,
					afterExists: true,
				});
			} else {
				undoEntries.push({
					path: opPath,
					beforeExists: before.exists,
					beforeContent: before.content,
					afterExists: true,
				});
			}
		}

		const result = await runApplyPatchBinary({
			patch: input,
			cwd,
			signal,
		});

		if (result.exitCode !== 0 && result.exitCode !== null) {
			const combined = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
			const message = combined.length > 0 ? combined : `apply_patch failed with code ${result.exitCode}`;
			throw new Error(message);
		}

		const output = result.stdout;

		// Fill in after hashes for files that exist after the patch.
		const finalizedUndoEntries: ApplyPatchUndoEntry[] = [];
		for (const entry of undoEntries) {
			if (entry.afterExists) {
				const afterContent = await readFile(entry.path, "utf8");
				finalizedUndoEntries.push({
					...(entry.beforeExists
						? { beforeExists: true as const, beforeContent: entry.beforeContent }
						: { beforeExists: false as const, beforeContent: null }),
					path: entry.path,
					afterExists: true as const,
					afterContentHash: hashContent(afterContent),
				});
			} else {
				finalizedUndoEntries.push({
					...(entry.beforeExists
						? { beforeExists: true as const, beforeContent: entry.beforeContent }
						: { beforeExists: false as const, beforeContent: null }),
					path: entry.path,
					afterExists: false as const,
				});
			}
		}

		return {
			content: [{ type: "text", text: output.length > 0 ? output : "(no output)" }],
			details: {
				parsed,
				undo: {
					entries: finalizedUndoEntries,
				},
			},
		};
	},
};
