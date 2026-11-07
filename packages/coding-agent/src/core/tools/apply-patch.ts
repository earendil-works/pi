import { dirname } from "node:path";
import { constants } from "fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { normalizeToLF } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { applyPatchRenderers } from "./renderers/apply-patch.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Ported-in-spirit from openai/codex `apply_patch` (Apache-2.0). Accepts a
 * standard unified diff (`---`/`+++`/`@@` hunks) and applies it strictly:
 * context must match exactly at the declared line, otherwise the call fails.
 * See NOTICE and docs/computer-use.md.
 */

const patchSchema = Type.Object({
	patch: Type.String({ description: "Unified diff to apply (git diff format, ---/+++/@@ hunks)" }),
});

export const applyPatchToolSystemPromptContribution = {
	snippet: "Apply a unified-diff patch to files",
	guidelines: [
		"Use only the Pi apply_patch tool declared in this session. Never use OpenCode's native apply_patch tool.",
		"Use apply_patch for complex multi-file edits. For a single targeted change, use edit instead.",
		"Patch hunks must match exactly; if a hunk fails, the tool errors and no file is written.",
	],
} as const;

export type ApplyPatchToolInput = Static<typeof patchSchema>;

type HunkLine = { kind: "context" | "add" | "delete"; text: string };

interface Hunk {
	/** Declared start line in the original file (1-based). */
	oldStart: number;
	lines: HunkLine[];
}

interface FilePatch {
	path: string;
	hunks: Hunk[];
}

export function parseUnifiedDiff(diff: string): FilePatch[] {
	const lines = diff.replace(/\r\n?/g, "\n").split("\n");
	const files: FilePatch[] = [];
	let current: FilePatch | undefined;
	let hunk: Hunk | undefined;

	const flushHunk = (): void => {
		if (!hunk || !current) return;
		current.hunks.push(hunk);
		hunk = undefined;
	};
	const flushFile = (): void => {
		flushHunk();
		if (current) files.push(current);
		current = undefined;
	};

	for (const line of lines) {
		if (line.startsWith("--- ")) {
			if (current || hunk) flushFile();
			hunk = undefined;
			current = { path: "", hunks: [] };
			continue;
		}
		if (line.startsWith("+++ ") && current && !current.path) {
			const raw = line.slice(4).trim();
			const normalized = raw === "/dev/null" ? "" : raw.replace(/^a\//, "").replace(/^b\//, "");
			if (!normalized) throw new Error("Patch has a /dev/null target; new files must use the write tool.");
			current.path = normalized;
			continue;
		}
		const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunkMatch) {
			if (!current) throw new Error("Patch hunk appears before a file header (--- / +++).");
			flushHunk();
			hunk = { oldStart: Number(hunkMatch[1]), lines: [] };
			continue;
		}
		if (!hunk) continue;
		if (line.startsWith("\\")) continue; // "\ No newline at end of file".
		const marker = line[0];
		const text = line.slice(1);
		if (marker === " ") hunk.lines.push({ kind: "context", text });
		else if (marker === "-") hunk.lines.push({ kind: "delete", text });
		else if (marker === "+") hunk.lines.push({ kind: "add", text });
		else if (line === "") hunk.lines.push({ kind: "context", text: "" });
		else throw new Error(`Invalid patch line: ${line}`);
	}
	flushFile();

	if (files.length === 0) throw new Error("No file hunks found in patch.");
	for (const file of files) {
		if (!file.path) throw new Error("Patch file header is missing a target path.");
		if (file.hunks.length === 0) throw new Error(`Patch for ${file.path} has no hunks.`);
	}
	return files;
}

function applyFileHunks(original: string, hunks: Hunk[], path: string): string {
	const normalized = normalizeToLF(original);
	const hadTrailingNewline = normalized.endsWith("\n") || normalized === "";
	const body = normalized === "" ? [] : normalized.split("\n").slice(0, -1);
	const out = [...body];
	for (const hunk of [...hunks].reverse()) {
		let cursor = hunk.oldStart - 1;
		if (cursor < 0 || cursor > out.length) throw new Error(`Hunk for ${path} starts out of bounds.`);
		const next: string[] = [];
		for (const { kind, text } of hunk.lines) {
			if (kind === "add") {
				next.push(text);
			} else {
				if (out[cursor] !== text) {
					throw new Error(`Hunk for ${path} does not match the file (line ${cursor + 1}).`);
				}
				if (kind === "context") next.push(text);
				cursor++;
			}
		}
		out.splice(hunk.oldStart - 1, cursor - (hunk.oldStart - 1), ...next);
	}
	return out.join("\n") + (hadTrailingNewline && out.length > 0 ? "\n" : "");
}

export interface ApplyPatchOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

const defaultApplyPatchOperations: ApplyPatchOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface ApplyPatchToolOptions {
	operations?: ApplyPatchOperations;
}

export function createApplyPatchToolDefinition(
	cwd: string,
	options?: ApplyPatchToolOptions,
): ToolDefinition<typeof patchSchema, undefined> {
	const ops = options?.operations ?? defaultApplyPatchOperations;
	return {
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Apply a unified diff (git diff format with ---/+++/@@ hunks) to files. Each hunk's context must match exactly or the whole call fails. Use for complex multi-file edits; for a single targeted change use edit instead.",
		promptSnippet: applyPatchToolSystemPromptContribution.snippet,
		promptGuidelines: [...applyPatchToolSystemPromptContribution.guidelines],
		parameters: patchSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ patch }: { patch: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const throwIfAborted = (): void => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			const files = parseUnifiedDiff(patch);
			const results: string[] = [];
			for (const file of files) {
				const absolutePath = resolveToCwd(file.path, ctx?.cwd || cwd);
				const result = await withFileMutationQueue(absolutePath, async () => {
					throwIfAborted();
					try {
						await fsAccess(absolutePath, constants.F_OK);
					} catch {
						throw new Error(`File does not exist: ${file.path}`);
					}
					const buffer = await ops.readFile(absolutePath);
					const { text: content } = splitBom(buffer.toString("utf-8"));
					const next = applyFileHunks(content, file.hunks, file.path);
					if (next === content) return `No changes to ${file.path}`;
					await ops.mkdir(dirname(absolutePath));
					throwIfAborted();
					await ops.writeFile(absolutePath, next);
					throwIfAborted();
					return `Patched ${file.path} (${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"})`;
				});
				results.push(result);
			}
			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: undefined,
			};
		},
		...applyPatchRenderers,
	};
}

export function createApplyPatchTool(
	cwd: string,
	options?: ApplyPatchToolOptions,
): TypeBoxAgentTool<typeof patchSchema> {
	return wrapToolDefinition(createApplyPatchToolDefinition(cwd, options));
}
