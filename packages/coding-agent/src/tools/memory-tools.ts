import type { AgentTool } from "@kennyfrc/mu-ai";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { enqueueArtifactMemoryWrite } from "../memory/background-write.js";
import { getArtifactMemoryScopeWorkspaceRef, readArtifactMemoryEntry, searchArtifactMemory } from "../memory/query.js";
import { getArtifactMemoryScope } from "../memory/store.js";
import { getToolDescription } from "../prompts/index.js";

const memoryScopeSchema = Type.Union([Type.Literal("workspace"), Type.Literal("global")]);

const memoryStoreSchema = Type.Object({
	kind: Type.String({ minLength: 1 }),
	summary: Type.String({ minLength: 1 }),
	scope: Type.Optional(memoryScopeSchema),
	workspaceRef: Type.Optional(Type.String({ minLength: 1 })),
	artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	sourceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	supersedes: Type.Optional(Type.String({ minLength: 1 })),
});

const memorySearchSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	scope: Type.Optional(memoryScopeSchema),
	workspaceRef: Type.Optional(Type.String({ minLength: 1 })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
});

const memoryReadSchema = Type.Object({
	entryId: Type.String({ minLength: 1 }),
	scope: Type.Optional(memoryScopeSchema),
	workspaceRef: Type.Optional(Type.String({ minLength: 1 })),
});

type MemoryStoreParams = Static<typeof memoryStoreSchema>;
type MemorySearchParams = Static<typeof memorySearchSchema>;
type MemoryReadParams = Static<typeof memoryReadSchema>;

function formatEntry(entry: {
	id: string;
	timestamp: string;
	kind: string;
	summary: string;
	workspaceRef: string;
	artifacts?: string[];
	sourceRefs?: string[];
	supersedes?: string;
}): string {
	const scope = getArtifactMemoryScope(entry.workspaceRef);
	const lines = [
		`id: ${entry.id}`,
		`timestamp: ${entry.timestamp}`,
		`scope: ${scope}`,
		`kind: ${entry.kind}`,
		`workspaceRef: ${entry.workspaceRef}`,
		`summary: ${entry.summary}`,
	];
	if (entry.artifacts?.length) {
		lines.push(`artifacts: ${entry.artifacts.join(", ")}`);
	}
	if (entry.sourceRefs?.length) {
		lines.push(`sourceRefs: ${entry.sourceRefs.join(", ")}`);
	}
	if (entry.supersedes) {
		lines.push(`supersedes: ${entry.supersedes}`);
	}
	return lines.join("\n");
}

export const memoryStoreTool: AgentTool<
	typeof memoryStoreSchema,
	{ queued: true; taskId: string; workspaceRef: string; scope: "workspace" | "global" }
> = {
	name: "memory_store",
	label: "memory_store",
	description: getToolDescription("memory_store"),
	parameters: memoryStoreSchema,
	execute: async (_toolCallId: string, args: MemoryStoreParams) => {
		const workspaceRef = getArtifactMemoryScopeWorkspaceRef({
			scope: args.scope,
			workspaceRef: args.workspaceRef,
		});
		const receipt = enqueueArtifactMemoryWrite({
			workspaceRef,
			entries: [
				{
					kind: args.kind,
					summary: args.summary,
					artifacts: args.artifacts,
					sourceRefs: args.sourceRefs,
					supersedes: args.supersedes,
					workspaceRef,
				},
			],
		});
		return {
			content: [{ type: "text", text: `Queued memory store ${receipt.taskId}` }],
			details: { ...receipt, scope: getArtifactMemoryScope(workspaceRef) },
		};
	},
};

export const memorySearchTool: AgentTool<
	typeof memorySearchSchema,
	{ hits: Array<{ entryId: string; summary: string; workspaceRef: string; artifacts: string[] }> }
> = {
	name: "memory_search",
	label: "memory_search",
	description: getToolDescription("memory_search"),
	parameters: memorySearchSchema,
	execute: async (_toolCallId: string, args: MemorySearchParams) => {
		const hits = await searchArtifactMemory({
			query: args.query,
			scope: args.scope,
			workspaceRef: args.workspaceRef,
			limit: args.limit,
		});
		if (hits.length === 0) {
			return {
				content: [{ type: "text", text: `No memory hits for query: ${args.query}` }],
				details: { hits: [] },
			};
		}

		return {
			content: [
				{
					type: "text",
					text: hits.map((hit, index) => `${index + 1}. ${hit.entry.id} :: ${hit.entry.summary}`).join("\n"),
				},
			],
			details: {
				hits: hits.map((hit) => ({
					entryId: hit.entry.id,
					summary: hit.entry.summary,
					workspaceRef: hit.entry.workspaceRef,
					artifacts: hit.entry.artifacts ?? [],
				})),
			},
		};
	},
};

export const memoryReadTool: AgentTool<typeof memoryReadSchema, { entryId: string | null }> = {
	name: "memory_read",
	label: "memory_read",
	description: getToolDescription("memory_read"),
	parameters: memoryReadSchema,
	execute: async (_toolCallId: string, args: MemoryReadParams) => {
		const entry = await readArtifactMemoryEntry({
			entryId: args.entryId,
			scope: args.scope,
			workspaceRef: args.workspaceRef,
		});
		if (!entry) {
			return {
				content: [{ type: "text", text: `Memory entry not found: ${args.entryId}` }],
				details: { entryId: null },
			};
		}

		return {
			content: [{ type: "text", text: formatEntry(entry) }],
			details: { entryId: entry.id },
		};
	},
};
