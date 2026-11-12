// What the command menu's session commands share, here and in other plugins (workspace, terminals): the session a
// command acts on, opening a panel in it, and the wrapper that hides a command while its session is archived.
import { keptIn } from "@p2/app/v1";
import {
	type CommandTarget,
	conversationRoute,
	getNavigation,
	knownMain,
	type Route,
	useCommandTarget,
	useObject,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { type Session, Sessions } from "./contract.ts";

/**
 * The session a command acts on: the target session, else the open one (a conversation target is a conversation of the
 * open session; the new-session screen has none).
 */
export const commandSession = (target: CommandTarget | undefined, route: Route): string | undefined =>
	target?.type === "session" ? target.id : route.session;

/**
 * Opens a panel of `session` (the workspace, the terminal: `change` adds it to the route): on the current route when it
 * shows the session, else with the session's main conversation, in one step, so Back returns to where the reader was.
 * Unlike a layer over a conversation (`openLayerIn`: two steps), a panel is part of the session's route, as the panels
 * a session opens with are (`conversationRoute`).
 */
export function openPanelIn(session: string, change: (route: Route) => Route): void {
	const nav = getNavigation();
	if (nav.route.session === session) void nav.push(change(nav.route));
	else void nav.closeThenPush((route) => change(conversationRoute(route, session, knownMain(session))));
}

/**
 * Renders `children` unless the command acts on a session that is archived or not known yet: an archived session
 * neither opens nor changes. Without a session (the new-session screen) they render.
 */
export function NotArchived({ children }: { children: ReactNode }) {
	const { id, session } = useCommandSession();
	return id === undefined || session?.archivedAt === null ? children : null;
}

/** The session the open menu's command acts on: its id, and its catalog row once known. */
export function useCommandSession(): { readonly id: string | undefined; readonly session: Session | undefined } {
	const id = commandSession(useCommandTarget(), useRoute());
	const sessions = useSessions();
	return { id, session: sessions?.find((each) => each.id === id) };
}

/** The catalog's rows the reader sees: every session for the owner, its own for a guest (kept while reconnecting). */
export const useSessions = (): readonly Session[] | undefined =>
	useReadable(keptIn(useObject(Sessions, {}), "owner", "guest")?.sessions);
