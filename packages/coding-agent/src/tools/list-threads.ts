import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { getSessionsRoot, type SearchGroup, SessionIndex } from "../session-index.js";

// --- Search Query Types ---

interface ParsedQuery {
	groups: SearchGroup[];
	hasStructuredSyntax: boolean; // true if query contains quotes or pipes
}

/**
 * Parse search query into structured groups.
 * - Spaces separate AND groups
 * - Quotes preserve phrases: "exact phrase"
 * - Pipes create OR groups: foo|bar|baz
 */
function parseSearchQuery(query: string): ParsedQuery {
	const groups: SearchGroup[] = [];
	let hasStructuredSyntax = false;

	// Regex to extract quoted phrases or unquoted tokens
	// Matches: "quoted phrase" or non-whitespace sequences
	const tokenRegex = /"([^"]*)"|\S+/g;
	const matches = query.matchAll(tokenRegex);

	for (const match of matches) {
		if (match[1] !== undefined) {
			// Quoted phrase (captured group 1)
			hasStructuredSyntax = true;
			const text = match[1].toLowerCase().trim();
			if (text) {
				groups.push({ type: "phrase", text });
			}
		} else {
			// Unquoted token - check for pipes
			const token = match[0];
			if (token.includes("|")) {
				hasStructuredSyntax = true;
				const alternatives = token
					.split("|")
					.map((s) => s.toLowerCase().trim())
					.filter((s) => s.length > 0);
				if (alternatives.length > 1) {
					groups.push({ type: "or", alternatives });
				} else if (alternatives.length === 1) {
					groups.push({ type: "term", text: alternatives[0] });
				}
			} else {
				const text = token.toLowerCase().trim();
				if (text) {
					groups.push({ type: "term", text });
				}
			}
		}
	}

	return { groups, hasStructuredSyntax };
}

const listThreadsSchema = Type.Object({
	search: Type.Optional(
		Type.String({
			description:
				'Filter threads by keyword. Space-separated terms use AND logic. Use quotes for exact phrases: "exact phrase". Use | for OR: doc|docs. Example: \'auth login|signin "error handling"\' matches threads with auth AND (login OR signin) AND "error handling".',
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description:
				"Filter threads by workspace path (case-insensitive substring match). Defaults to current working directory if not provided.",
		}),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max threads to return (default: 25)" })),
});

function getRelativeDate(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays} days ago`;
	return date.toLocaleDateString();
}

export const listThreadsTool: AgentTool<typeof listThreadsSchema> = {
	name: "list_threads",
	label: "list_threads",
	description: getToolDescription("list_threads"),
	parameters: listThreadsSchema,
	execute: async (
		_toolCallId: string,
		{ search, workspace, limit }: { search?: string; workspace?: string; limit?: number },
	) => {
		const index = new SessionIndex(getSessionsRoot());

		// Use current workspace if not provided
		const effectiveWorkspace = workspace?.trim() || process.cwd();
		const max = limit || 25;

		try {
			let sessions: Awaited<ReturnType<typeof index.listRecent>>;

			if (search?.trim()) {
				const parsed = parseSearchQuery(search);

				if (parsed.groups.length === 0) {
					// Empty query after parsing - list recent
					sessions = await index.listRecent(effectiveWorkspace, max);
				} else {
					// Search with AND matching
					sessions = await index.search(effectiveWorkspace, parsed.groups, max);

					// Relaxation: if AND returns 0 and query is plain terms (no quotes/pipes), retry with OR
					if (sessions.length === 0 && parsed.groups.length >= 2 && !parsed.hasStructuredSyntax) {
						sessions = await index.searchAny(effectiveWorkspace, parsed.groups, max);
					}
				}
			} else {
				// No search - just list recent
				sessions = await index.listRecent(effectiveWorkspace, max);
			}

			const results = sessions.map((s) => ({
				id: s.id,
				date: s.modified.toISOString(),
				relativeDate: getRelativeDate(s.modified),
				messageCount: s.messageCount,
				workspace: s.cwd,
				preview: s.firstMessage.substring(0, 200) + (s.firstMessage.length > 200 ? "..." : ""),
			}));

			return {
				content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
				details: undefined,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Error listing threads: ${message}` }],
				details: undefined,
				isError: true,
			};
		}
	},
};
