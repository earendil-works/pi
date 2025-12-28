import type { AgentTool } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { SessionManager } from "../session-manager.js";

const listThreadsSchema = Type.Object({
	search: Type.Optional(Type.String({ description: "Filter threads by keyword (message content)" })),
	workspace: Type.Optional(Type.String({ description: "Filter threads by workspace path (substring match)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max threads to return (default: 10)" })),
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
		const mgr = new SessionManager(false, undefined, true);

		try {
			const sessions = mgr.loadAllSessionsGlobal();

			let filtered = sessions;
			if (search) {
				const term = search.toLowerCase();
				filtered = sessions.filter(
					(s) => s.firstMessage.toLowerCase().includes(term) || s.allMessagesText.toLowerCase().includes(term),
				);
			}

			// Apply workspace filter if provided (case-insensitive substring match)
			const workspaceTerm = workspace?.trim();
			if (workspaceTerm) {
				const term = workspaceTerm.toLowerCase();
				// If search was already applied, filter from those results; otherwise filter from all sessions
				const sourceSessions = search ? filtered : sessions;
				filtered = sourceSessions.filter((s) => s.cwd.toLowerCase().includes(term));
			}

			// Sort by date desc
			filtered.sort((a, b) => b.modified.getTime() - a.modified.getTime());

			const max = limit || 10;
			const results = filtered.slice(0, max).map((s) => ({
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
