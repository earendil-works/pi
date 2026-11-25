import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, liveIn } from "@p2/app/v1";
import type { Navigation, WorkspaceRoute } from "@p2/app/v1/web";
import {
	Commands,
	FolderIcon,
	locationLabel,
	Slots,
	useCanWrite,
	useComposerState,
	useNavigation,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useStatus,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Chat } from "../chat/contract.ts";
import { Sessions } from "../sessions/contract.ts";
import { conversationLocation, Subagents } from "../subagents/contract.ts";
import { WORKSPACE_COMMANDS } from "./commands.tsx";
import { Workspace } from "./contract.ts";
import { withWorkspace } from "./tabs.ts";
import { WorkspacePanel as MobileWorkspacePanel } from "./Workspace.tsx";

function WorkspaceButton() {
	const nav = useNavigation();
	const route = useRoute();
	const canWrite = useCanWrite(route.session);
	if (!route.session || !canWrite) return null;
	return (
		<button
			type="button"
			className={`icon-button workspace-toggle ${route.workspace ? "on" : ""}`}
			aria-label="Workspace files and changes"
			aria-pressed={!!route.workspace}
			onClick={() =>
				route.workspace
					? void nav.close((current) => ({ ...current, workspace: undefined }))
					: void nav.push(withWorkspace(route, "files"))
			}
		>
			<FolderIcon />
		</button>
	);
}

function WorkspacePanel() {
	const route = useRoute(),
		nav = useNavigation();
	const owner = useOwner();
	const canWrite = useCanWrite(route.session);
	// Retry opens the workspace again: a new panel holds a new reference.
	const [attempt, setAttempt] = useState(0);
	if (!route.session || !route.workspace || !canWrite) return null;
	return (
		<NativePanel
			key={`${route.session}:${route.conversation}:${attempt}`}
			onRetry={() => setAttempt((current) => current + 1)}
			session={route.session}
			conversation={route.conversation}
			owner={owner}
			nav={nav}
			route={route.workspace}
		/>
	);
}
function NativePanel({
	session,
	conversation,
	owner,
	nav,
	route,
	onRetry,
}: {
	onRetry: () => void;
	session: string;
	conversation: number;
	owner: boolean;
	nav: Navigation;
	route: WorkspaceRoute;
}) {
	const workspace = useObject(Workspace, { session, conversation });
	// Only to send review comments: a method-only reference (the chat view holds the state when it is open).
	const chat = useObject(Chat, { session, conversation });
	const rows = useReadable(liveIn(useObject(Sessions, {}), "owner", "guest")?.sessions);
	const children = useReadable(liveIn(useObject(Subagents, {}), "reader")?.children);
	// Where the viewed conversation works: a subagent may have its own location (e.g. a git worktree, another machine).
	const location = conversationLocation(
		rows?.find((row) => row.id === session),
		children?.[session]?.find((child) => child.conversationId === conversation),
	);
	const cwd = location?.cwd ?? "";
	const { setError } = useComposerState();
	// Why the workspace is not open: a failed open shows its error (Retry opens it again with a new reference)
	// instead of loading forever.
	const [unavailable, setUnavailable] = useState<string>();
	useEffect(() => {
		if (!workspace) return;
		return follow(workspace.state, (state) => {
			if (state.kind === "live") setUnavailable(undefined);
			else if (state.kind === "ended") setUnavailable(state.error.message);
			else if (state.kind === "failed" && state.cause.kind === "broken") setUnavailable(state.cause.error.message);
		});
	}, [workspace]);
	return (
		<MobileWorkspacePanel
			workspace={workspace}
			attached={useStatus(workspace) === "live"}
			{...(unavailable === undefined ? {} : { unavailable })}
			onRetry={onRetry}
			label={(at) => locationLabel(at.env, at.cwd)}
			nav={nav}
			route={route}
			sessionId={session}
			conversationId={conversation}
			cwd={cwd}
			{...(location ? { where: locationLabel(location.env, location.cwd) } : {})}
			owner={owner}
			onSend={async (text) => {
				try {
					const writer = liveIn(chat, "participant");
					if (!writer) throw new Error("This conversation is read-only");
					await writer.send({ text, requestId: crypto.randomUUID(), whenBusy: "steer" }, BACKGROUND_CONTEXT);
				} catch (error) {
					setError(error instanceof Error ? error.message : "Could not send comments");
					throw error;
				}
			}}
		/>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-workspace", (self) => {
		self.contribute(Slots, { "workspace-actions": WorkspaceButton, "workspace-panel": WorkspacePanel });
		self.contribute(Commands, WORKSPACE_COMMANDS);
	});
});
