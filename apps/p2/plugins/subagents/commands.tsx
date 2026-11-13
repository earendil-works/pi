// The command menu's conversation commands (the TUI's `/agents` and `/main`): Switch conversation…, Back to main
// conversation, and a root search over the subagents' names.
import { keptIn } from "@p2/app/v1";
import {
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	ConversationsIcon,
	knownMain,
	locationLabel,
	ParentIcon,
	useCommandMatches,
	useCommandMenu,
	useObject,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo } from "react";
import { conversationOf } from "../chat/contract.ts";
import type { Session } from "../sessions/contract.ts";
import { RunMark, useCommandSession, useOpenFromMenu, WorkingMark } from "../sessions/contract.web.tsx";
import { SessionStatus } from "../status/contract.ts";
import { byRecentActivity, type Child, Subagents, shortModelName } from "./contract.ts";
import { openMain } from "./contract.web.ts";

// Order 15: after Session (10), before Model (20), whose commands act on the conversation switched to.
export const CONVERSATION_COMMANDS = {
	"subagents.switch": {
		title: "Switch conversation…",
		group: "Conversation",
		order: 15,
		icon: ConversationsIcon,
		keywords: ["agents", "subagents", "open subagent"],
		target: ["session", "conversation"],
		Shown: HasSubagents,
		action: { kind: "page", page: "conversations" },
	},
	"subagents.main": {
		title: "Back to main conversation",
		group: "Conversation",
		order: 15,
		icon: ParentIcon,
		keywords: ["parent", "leave subagent"],
		// The main conversation's target is the session, so this shows only on a subagent's.
		target: ["conversation"],
		action: { kind: "run", run: backToMain },
	},
} satisfies Record<string, Command>;

export const CONVERSATION_PAGES = {
	conversations: { label: "Conversations", placeholder: "Search conversations…", Body: ConversationsPage },
} satisfies Record<string, CommandPage>;

// Order 1005: after the Sessions search (1000), so a query matching a session and a subagent highlights the session.
export const CONVERSATION_SEARCH: CommandSearch = { group: "Conversations", order: 1005, Results: ConversationResults };

function backToMain(ctx: CommandContext): void {
	const at = ctx.target?.type === "conversation" ? conversationOf(ctx.target.id) : undefined;
	if (at) openMain(at.session, knownMain(at.session));
}

function HasSubagents({ children }: { children: ReactNode }) {
	const { session } = useCommandSession();
	return useConversations(session).subagents.length > 0 ? children : null;
}

type Conversation = {
	readonly kind: "main" | "subagent";
	readonly id: number;
	readonly title: string;
	readonly suffix: string;
};

const titleOf = (conversation: Conversation): string => conversation.title;

function ConversationsPage() {
	const { session } = useCommandSession();
	const matches = useCommandMatches(useConversations(session).all, titleOf);
	if (session === undefined) return null;
	return (
		<CommandMenu.Group heading="Conversations">
			<ConversationRows session={session.id} conversations={matches} />
		</CommandMenu.Group>
	);
}

const SEARCH_ROWS = 5;

function ConversationResults() {
	const { session } = useCommandSession();
	const matches = useCommandMatches(useConversations(session).subagents, titleOf);
	if (session === undefined) return null;
	return <ConversationRows session={session.id} conversations={matches.slice(0, SEARCH_ROWS)} />;
}

type Listed = { readonly all: readonly Conversation[]; readonly subagents: readonly Conversation[] };

const NONE: Listed = { all: [], subagents: [] };

/** The main conversation, then the subagents: archived last, otherwise as the sidebar orders them. */
function useConversations(session: Session | undefined): Listed {
	const children = useReadable(keptIn(useObject(Subagents, {}), "reader")?.children);
	const own = session === undefined ? undefined : children?.[session.id];
	return useMemo(() => {
		if (session === undefined || session.archivedAt !== null) return NONE;
		const subagents = (own ?? [])
			// One-shot agents belong to their script's tool card.
			.filter((child) => child.kind !== "agent")
			.toSorted((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false) || byRecentActivity(a, b))
			.map(subagentConversation);
		return { all: [mainConversation(session), ...subagents], subagents };
	}, [session, own]);
}

// No location: the main conversation works where the session does.
const mainConversation = (session: Session): Conversation => ({
	kind: "main",
	id: session.main,
	title: "Main conversation",
	suffix: shortModelName(session.model.modelId),
});

const subagentConversation = (child: Child): Conversation => ({
	kind: "subagent",
	id: child.conversationId,
	title: child.name,
	suffix: [
		...(child.archived ? ["Archived"] : []),
		shortModelName(child.model),
		...(child.location ? [locationLabel(child.location.env, child.location.cwd)] : []),
	].join(" · "),
});

/** Picking a subagent opens it as a new step; the main conversation opens as Back to main conversation does. */
function ConversationRows({ session, conversations }: { session: string; conversations: readonly Conversation[] }) {
	const { close } = useCommandMenu();
	const open = useOpenFromMenu();
	const route = useRoute();
	const busy = useReadable(keptIn(useObject(SessionStatus, {}), "reader")?.statuses)?.[session]?.busy;
	return conversations.map((conversation) => (
		<CommandMenu.Row
			key={conversation.id}
			title={conversation.title}
			icon={busy?.includes(conversation.id) ? WorkingMark : IdleMark}
			suffix={conversation.suffix}
			checked={route.session === session && route.conversation === conversation.id}
			onSelect={async () => {
				if (conversation.kind === "subagent") return open({ session, conversation: conversation.id });
				await close();
				openMain(session, conversation.id);
			}}
		/>
	));
}

const IdleMark = () => <RunMark state="idle" />;
