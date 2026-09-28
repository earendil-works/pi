/**
 * TypeBox parameter schemas and registration for the memory_save /
 * memory_recall tools (adapted from openclaude's auto-memory system).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { MemoryStore } from "./store.ts";
import { MEMORY_TYPES } from "./store.ts";

export const MemorySaveParams = Type.Object({
	name: Type.String({
		description: 'Short descriptive name for the memory, e.g. "prefers-pnpm" or "auth-flow-decision"',
	}),
	description: Type.String({
		description: "One-line description of what this memory captures; used to judge relevance in future sessions",
	}),
	type: StringEnum(MEMORY_TYPES, {
		description:
			"user: who the user is (role, preferences, goals) | " +
			"feedback: guidance from corrections or confirmed approaches | " +
			"project: ongoing work context not derivable from the code | " +
			"reference: pointers to external resources (docs, dashboards, tickets)",
	}),
	body: Type.String({
		description:
			"Markdown content of the memory. For feedback and project memories, structure the body as the " +
			'fact or rule, then "**Why:**" and "**How to apply:**" paragraphs.',
	}),
});

export const MemoryRecallParams = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Keywords to search memory names, descriptions, and contents for (all terms must match)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of memories to return (default 5)" })),
});

export interface MemoryToolsDeps {
	storeFor(ctx: ExtensionContext): MemoryStore;
}

const MEMORY_SAVE_SNIPPET =
	"memory_save: persist a durable fact to long-term memory — user preferences and profile, corrections or " +
	"confirmed approaches (feedback), project conventions and decisions not derivable from the code, or stable " +
	"reference pointers. Skip session-scoped state, secrets, and anything the repo already records.";

const MEMORY_RECALL_SNIPPET =
	"memory_recall: search long-term memory by keyword; call when a task touches user preferences, prior " +
	"decisions, or project conventions that may have been remembered in earlier sessions";

export function registerMemoryTools(pi: ExtensionAPI, deps: MemoryToolsDeps): void {
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Save a durable memory about the user or project to long-term storage (markdown file with frontmatter, " +
			"indexed in MEMORY.md and injected into future sessions). Save user preferences, feedback the user gave " +
			"(corrections and confirmed approaches), project conventions/decisions not derivable from the code, and " +
			"reference pointers. Do NOT save: secrets or credentials, session-scoped state, or anything derivable " +
			"from the repository. Prefer re-saving under an existing name to update it rather than creating a near-duplicate.",
		parameters: MemorySaveParams,
		promptSnippet: MEMORY_SAVE_SNIPPET,
		// Writes the shared MEMORY.md index; must not race another save.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = deps.storeFor(ctx);
			const existed = (await store.list()).some((m) => m.name === params.name);
			const memory = await store.save({
				name: params.name,
				description: params.description,
				type: params.type,
				body: params.body,
			});
			return {
				content: [
					{
						type: "text",
						text: `${existed ? "Updated" : "Saved"} memory "${memory.name}" (${memory.type}) at ${memory.fileName}`,
					},
				],
				details: { memory },
			};
		},

		renderCall(args, theme, _context) {
			const text = theme.fg("toolTitle", theme.bold("memory_save ")) + theme.fg("accent", `"${args.name}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search long-term memory for previously saved memories matching the given keywords. Returns the full " +
			"content of each match. Use to check for user preferences, past decisions, or project conventions before " +
			"acting.",
		parameters: MemoryRecallParams,
		promptSnippet: MEMORY_RECALL_SNIPPET,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = deps.storeFor(ctx);
			const limit = params.limit ?? 5;
			const memories = await store.search(params.query ?? "", limit);
			if (memories.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.query
								? `No memories matching "${params.query}".`
								: "No memories saved for this project yet.",
						},
					],
					details: { memories: [] },
				};
			}
			const text = memories
				.map((m) => `--- ${m.name} (${m.type}) — ${m.fileName} ---\n${m.description}\n\n${m.body}`)
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { memories: memories.map((m) => ({ name: m.name, type: m.type, fileName: m.fileName })) },
			};
		},

		renderCall(args, theme, _context) {
			const text =
				theme.fg("toolTitle", theme.bold("memory_recall ")) +
				theme.fg("accent", args.query ? `"${args.query}"` : "(all)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { memories: { name: string }[] } | undefined;
			const text = result.content[0];
			if (!details || details.memories.length === 0) {
				return new Text(theme.fg("dim", text?.type === "text" ? text.text : "No memories"), 0, 0);
			}
			const display = expanded ? details.memories : details.memories.slice(0, 5);
			let listText = theme.fg("muted", `${details.memories.length} memory(ies):`);
			for (const m of display) {
				listText += `\n${theme.fg("accent", "•")} ${theme.fg("muted", m.name)}`;
			}
			if (!expanded && details.memories.length > 5) {
				listText += `\n${theme.fg("dim", `... ${details.memories.length - 5} more`)}`;
			}
			return new Text(listText, 0, 0);
		},
	});
}
