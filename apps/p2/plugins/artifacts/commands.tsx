// The artifacts plugin's part of the command menu: Open artifact… on a session (its main conversation) or a subagent's
// conversation, with the page listing that conversation's artifacts, and the artifacts the root's query matches by
// title while their conversation is on screen. Picking one opens the viewer, as the side panel's list does.
import { keptIn } from "@p2/app/v1";
import {
	ArtifactIcon,
	type Command,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	openLayerIn,
	useCommandMatches,
	useCommandMenu,
	useCommandTarget,
	useObject,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo } from "react";
import { conversationOf } from "../chat/contract.ts";
import { Sessions } from "../sessions/contract.ts";
import { type ArtifactInfo, ArtifactList } from "./contract.ts";
import { viewerLayer } from "./viewer.ts";

/** The commands, by id. */
export const ARTIFACT_COMMANDS: Readonly<Record<string, Command>> = {
	"artifacts.open": {
		title: "Open artifact…",
		group: "Artifacts",
		order: 50,
		icon: ArtifactIcon,
		keywords: ["show artifacts", "view artifact"],
		target: ["session", "conversation"],
		Shown: HasArtifacts,
		action: { kind: "page", page: "artifacts" },
	},
};

/** The pages, by name. */
export const ARTIFACT_PAGES: Readonly<Record<string, CommandPage>> = {
	artifacts: {
		label: "Artifacts",
		placeholder: "Search artifacts…",
		empty: "No artifacts in this conversation",
		Body: ArtifactsPage,
	},
};

/**
 * The artifacts the root's query matches, in the Artifacts group (the command's, so they sit where it does; on their
 * own past the Sessions search when the command is not shown).
 */
export const ARTIFACT_SEARCH: CommandSearch = { group: "Artifacts", order: 1010, Results: ArtifactResults };

/** A conversation: where its artifacts are listed and the viewer opens over. */
type At = { readonly session: string; readonly conversation: number };

/**
 * The conversation the target names: a subagent's conversation, or a session's main one while the session is not
 * archived (its worker does not start, so its list never arrives).
 */
function useTargetConversation(): At | undefined {
	const target = useCommandTarget();
	const sessions = useReadable(keptIn(useObject(Sessions, {}), "owner", "guest")?.sessions);
	if (target?.type === "conversation") return conversationOf(target.id);
	if (target?.type !== "session") return undefined;
	const session = sessions?.find((each) => each.id === target.id);
	return session?.archivedAt === null ? { session: session.id, conversation: session.main } : undefined;
}

/** Whether `at` is the conversation on screen. */
function useOnScreen(at: At | undefined): boolean {
	const route = useRoute();
	return at !== undefined && route.session === at.session && route.conversation === at.conversation;
}

/** Every version in `at`, the newest first, as the side panel lists them (undefined until the list arrives). */
function useArtifacts(at: At | undefined): readonly ArtifactInfo[] | undefined {
	const artifacts = useReadable(useObject(ArtifactList, at)?.artifacts);
	return useMemo(() => artifacts?.toReversed(), [artifacts]);
}

/**
 * Renders `children` while the target conversation has artifacts. Its list is held here only while it is on screen
 * (the top bar's button holds it already); for another session the command shows unconditionally, so opening the menu
 * over a sidebar row never starts that session's worker: the page holds the list once the reader opens it.
 */
function HasArtifacts({ children }: { children: ReactNode }) {
	const at = useTargetConversation();
	const onScreen = useOnScreen(at);
	const artifacts = useArtifacts(onScreen ? at : undefined);
	if (at === undefined) return null;
	return !onScreen || artifacts?.length ? children : null;
}

const textOf = (artifact: ArtifactInfo): string => `${artifact.title} ${artifact.name}`;

/** The target conversation's artifacts, every version; picking one opens it in the viewer. */
function ArtifactsPage() {
	const at = useTargetConversation();
	const matches = useCommandMatches(useArtifacts(at) ?? NONE, textOf);
	if (at === undefined) return null;
	return (
		<CommandMenu.Group heading="Artifacts">
			{matches.map((artifact) => (
				<ArtifactRow key={`${artifact.name}:${artifact.version}`} at={at} artifact={artifact} />
			))}
		</CommandMenu.Group>
	);
}

const NONE: readonly ArtifactInfo[] = [];

/** How many artifacts the root's results show: the best matches; the page has the rest. */
const SEARCH_ROWS = 5;

/**
 * The latest version of each artifact of the target conversation the root's query matches, while that conversation is
 * on screen: typing never holds another session's list (nor starts its worker).
 */
function ArtifactResults() {
	const at = useTargetConversation();
	const onScreen = useOnScreen(at);
	const artifacts = useArtifacts(onScreen ? at : undefined);
	const latest = useMemo(() => latestVersions(artifacts ?? NONE), [artifacts]);
	const matches = useCommandMatches(latest, textOf);
	if (at === undefined || !onScreen) return null;
	return matches
		.slice(0, SEARCH_ROWS)
		.map((artifact) => <ArtifactRow key={`${artifact.name}:${artifact.version}`} at={at} artifact={artifact} />);
}

/** The first version of each name in `artifacts` (newest first: the latest). */
function latestVersions(artifacts: readonly ArtifactInfo[]): readonly ArtifactInfo[] {
	const seen = new Set<string>();
	return artifacts.filter((artifact) => {
		if (seen.has(artifact.name)) return false;
		seen.add(artifact.name);
		return true;
	});
}

/** An artifact version: its title, type and version, as the side panel's row; it opens over its conversation. */
function ArtifactRow({ at, artifact }: { at: At; artifact: ArtifactInfo }) {
	const { close } = useCommandMenu();
	return (
		<CommandMenu.Row
			title={artifact.title}
			suffix={`${artifact.type} · v${artifact.version}`}
			onSelect={async () => {
				await close();
				openLayerIn(at.session, at.conversation, viewerLayer({ kind: "artifact", artifact }));
			}}
		/>
	);
}
