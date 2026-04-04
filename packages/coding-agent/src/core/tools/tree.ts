import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import { getProjectTreeNode, getProjectTreeSnapshot, renderProjectSubtree } from "./project-tree.js";

const treeSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to inspect (default: current directory)" })),
	depth: Type.Optional(Type.Number({ description: "Maximum directory depth to render (default: 3)" })),
	refresh: Type.Optional(Type.Boolean({ description: "Refresh the cached project tree before rendering" })),
});

export type TreeToolInput = Static<typeof treeSchema>;

export interface TreeToolDetails {
	root: string;
	generatedAt: number;
	totalNodes: number;
}

export function createTreeTool(cwd: string): AgentTool<typeof treeSchema> {
	return {
		name: "tree",
		label: "tree",
		description:
			"Show an ignore-aware project tree for a directory. Respects .gitignore, .ignore, .fdignore, and .piignore. Use this before broad reads when you need to shortlist files.",
		parameters: treeSchema,
		execute: async (_toolCallId, params) => {
			const targetPath = resolveToCwd(params.path || ".", cwd);
			const depth = params.depth ?? 3;
			const snapshot = getProjectTreeSnapshot(cwd, { refresh: params.refresh });
			const node = getProjectTreeNode(cwd, targetPath, { refresh: params.refresh });

			if (!node) {
				throw new Error(`Path not found in project tree: ${params.path || "."}`);
			}

			const text = renderProjectSubtree(cwd, targetPath, {
				refresh: false,
				depth,
			});

			return {
				content: [{ type: "text", text: text || "(empty tree)" }],
				details: {
					root: node.relativePath,
					generatedAt: snapshot.generatedAt,
					totalNodes: snapshot.totalNodes,
				} satisfies TreeToolDetails,
			};
		},
	};
}

export const treeTool = createTreeTool(process.cwd());
