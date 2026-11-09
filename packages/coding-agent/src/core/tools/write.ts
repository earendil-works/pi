import { constants } from "fs";
import { mkdir as fsMkdir, open as fsOpen, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { encodeUtf16, getUtf16Encoding } from "./file-encoding.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * Read up to `length` bytes from the start of a file; rejects if it cannot be read, for example because it does
	 * not exist. With writeFileBytes, used to overwrite UTF-16 files as UTF-16; without both, files are written as UTF-8.
	 */
	readFileStart?: (absolutePath: string, length: number) => Promise<Buffer>;
	/** Write raw bytes to a file */
	writeFileBytes?: (absolutePath: string, content: Buffer) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFileStart: async (path, length) => {
		// Non-blocking, so that opening a FIFO does not wait for a writer.
		const file = await fsOpen(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, 0);
			return buffer.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
	},
	writeFileBytes: (path, content) => fsWriteFile(path, content),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				const writeContent = await getContentWriter(ops, absolutePath);
				throwIfAborted();
				await writeContent(content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					details: undefined,
				};
			});
		},
		...writeRenderers,
	};
}

/** Writer of content in the encoding of the existing file: UTF-16 with a byte order mark stays UTF-16, else UTF-8. */
async function getContentWriter(
	ops: WriteOperations,
	absolutePath: string,
): Promise<(content: string) => Promise<void>> {
	const { readFileStart, writeFileBytes } = ops;
	if (readFileStart && writeFileBytes) {
		// A file that cannot be read, for example because it does not exist yet, is written as UTF-8.
		const start = await readFileStart.call(ops, absolutePath, 2).catch(() => new Uint8Array(0));
		const encoding = getUtf16Encoding(start);
		// Call as a method: custom operations may be class instances.
		if (encoding) return (content) => writeFileBytes.call(ops, absolutePath, encodeUtf16(content, encoding));
	}
	return (content) => ops.writeFile(absolutePath, content);
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): TypeBoxAgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
