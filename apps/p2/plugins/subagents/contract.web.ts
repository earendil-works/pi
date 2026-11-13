// What the subagents plugin shares with other web facets: going back to a session's main conversation.
import { conversationRoute, getNavigation } from "@p2/app/v1/web";

/** Opens `session`'s main conversation `main`: a step back when the reader came from it, else a new step. */
export function openMain(session: string, main: number): void {
	const nav = getNavigation();
	void nav.backOrPush(conversationRoute(nav.route, session, main));
}
