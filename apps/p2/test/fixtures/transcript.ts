// A transcript as the chat shows it, for browser-only component fixtures: a scroller with the virtual list's rows, and
// the tools' contributions of p2's plugins, as the chat plugin provides them from their web facets.
import { createElement, useMemo } from "react";
import { agentActivity } from "../../plugins/agent/activity.tsx";
import { artifactActivity } from "../../plugins/artifacts/activity.tsx";
import { codemodeActivity } from "../../plugins/codemode/activity.tsx";
import { codingToolActivities } from "../../plugins/coding-tools/activity.tsx";
import { conversationsActivity } from "../../plugins/conversations/activity.tsx";
import { historyActivities } from "../../plugins/history/activity.tsx";
import { portsActivity } from "../../plugins/ports/activity.tsx";
import { powershellActivity } from "../../plugins/powershell/activity.tsx";
import { sendFileActivity } from "../../plugins/send-file/activity.tsx";
import { subagentActivity } from "../../plugins/subagents/activity.tsx";
import { terminalActivity } from "../../plugins/terminals/activity.tsx";
import type { Detail, ToolActivityTable } from "../../src/web/activity/model.ts";
import { Messages, rowEstimates, transcriptRows } from "../../src/web/Chat.tsx";
import { ToolActivityContext } from "../../src/web/chat-context.ts";
import type { Transcript } from "../../src/web/transcript.ts";
import { useChatScroll } from "../../src/web/use-chat-scroll.ts";

/** The tools' contributions of p2's plugins, by tool name. */
export const PLUGIN_TOOLS: ToolActivityTable = new Map(
	Object.entries({
		...codingToolActivities,
		...historyActivities,
		agent: agentActivity,
		artifact: artifactActivity,
		codemode: codemodeActivity,
		conversations: conversationsActivity,
		ports: portsActivity,
		powershell: powershellActivity,
		send_file: sendFileActivity,
		subagent: subagentActivity,
		terminal: terminalActivity,
	}),
);

/**
 * `tools`: the contributions to show calls with; the plugins' by default, none for the generic look. `detail`: how much
 * of a turn shows (settings.json `detail`; the default without it).
 */
export function TranscriptFixture({
	transcript,
	tools = PLUGIN_TOOLS,
	detail,
}: {
	transcript: Transcript;
	tools?: ToolActivityTable;
	detail?: Detail;
}) {
	const rows = useMemo(
		() => transcriptRows(transcript.items, tools, transcript.working, true, detail),
		[transcript, tools, detail],
	);
	const follow = useChatScroll({ rows, estimates: rowEstimates });
	return createElement(
		ToolActivityContext.Provider,
		{ value: tools },
		createElement(
			"div",
			{ className: "scroller transcript", ref: follow.scroller },
			createElement(Messages, { transcript, rows, list: follow.list, range: follow.range }),
		),
	);
}
