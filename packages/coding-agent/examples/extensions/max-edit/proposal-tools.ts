import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const EditProposalParams = Type.Object({
	path: Type.String({ description: "File path to edit" }),
	oldText: Type.String({ description: "Exact existing text to replace" }),
	newText: Type.String({ description: "Replacement text" }),
	summary: Type.Optional(Type.String({ description: "Short explanation of the proposed edit" })),
});

const WriteProposalParams = Type.Object({
	path: Type.String({ description: "File path to write" }),
	content: Type.String({ description: "Complete new file contents" }),
	summary: Type.Optional(Type.String({ description: "Short explanation of the proposed write" })),
});

export default function proposalTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "propose_edit",
		label: "Propose Edit",
		description: "Record an exact file edit proposal without applying it.",
		parameters: EditProposalParams,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Queued edit proposal for ${params.path}` }],
				details: {
					kind: "edit",
					path: params.path,
					oldText: params.oldText,
					newText: params.newText,
					summary: params.summary,
				},
			};
		},
	});

	pi.registerTool({
		name: "propose_write",
		label: "Propose Write",
		description: "Record a file write proposal without applying it.",
		parameters: WriteProposalParams,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Queued write proposal for ${params.path}` }],
				details: {
					kind: "write",
					path: params.path,
					content: params.content,
					summary: params.summary,
				},
			};
		},
	});
}
