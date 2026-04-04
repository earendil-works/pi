import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import { buildFilePreview, collectProjectFiles, getProjectTreeNode, renderProjectSubtree } from "./project-tree.js";

const readSubtreeSchema = Type.Object({
	path: Type.String({ description: "Directory or file path to inspect" }),
	depth: Type.Optional(Type.Number({ description: "Maximum tree depth to render (default: 2)" })),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum number of file previews to include (default: 8)" })),
	maxBytes: Type.Optional(
		Type.Number({ description: "Maximum total preview bytes across all files (default: 16384)" }),
	),
	refresh: Type.Optional(Type.Boolean({ description: "Refresh the cached project tree before rendering" })),
});

export type ReadSubtreeToolInput = Static<typeof readSubtreeSchema>;

export interface ReadSubtreeToolDetails {
	root: string;
	previewedFiles: string[];
	truncated: boolean;
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_PREVIEW_LINES = 40;

export function createReadSubtreeTool(cwd: string): AgentTool<typeof readSubtreeSchema> {
	return {
		name: "read_subtree",
		label: "read_subtree",
		description:
			"Inspect a subtree before full reads. Returns an ignore-aware subtree listing plus capped inline previews of likely files. Respects .gitignore, .ignore, .fdignore, and .piignore.",
		parameters: readSubtreeSchema,
		execute: async (_toolCallId, params) => {
			const targetPath = resolveToCwd(params.path, cwd);
			const node = getProjectTreeNode(cwd, targetPath, { refresh: params.refresh });
			if (!node) {
				throw new Error(`Path not found in project tree: ${params.path}`);
			}

			const depth = params.depth ?? 2;
			const maxFiles = params.maxFiles ?? DEFAULT_MAX_FILES;
			let remainingBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
			const files = collectProjectFiles(node, maxFiles);
			const previewedFiles: string[] = [];
			const sections: string[] = [];

			sections.push(`Subtree: ${node.relativePath}`);
			sections.push("");
			sections.push("Tree:");
			sections.push(
				renderProjectSubtree(cwd, targetPath, {
					refresh: false,
					depth,
					maxLines: 80,
				}) || "(empty tree)",
			);

			if (files.length > 0) {
				sections.push("");
				sections.push("File previews:");
			}

			let truncated = false;

			for (const fileNode of files) {
				if (remainingBytes <= 0) {
					truncated = true;
					break;
				}

				const preview = buildFilePreview(fileNode.absolutePath, {
					maxBytes: remainingBytes,
					maxLines: DEFAULT_PREVIEW_LINES,
				});
				if (!preview) {
					continue;
				}

				previewedFiles.push(fileNode.relativePath);
				remainingBytes -= Buffer.byteLength(preview.content, "utf-8");
				sections.push(`--- ${fileNode.relativePath} ---`);
				sections.push(preview.content);
				if (preview.truncated) {
					truncated = true;
				}
			}

			if (files.length > previewedFiles.length) {
				truncated = true;
			}

			if (truncated) {
				sections.push("");
				sections.push("[Preview truncated. Use read on a specific file for full contents.]");
			}

			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: {
					root: node.relativePath,
					previewedFiles,
					truncated,
				} satisfies ReadSubtreeToolDetails,
			};
		},
	};
}

export const readSubtreeTool = createReadSubtreeTool(process.cwd());
