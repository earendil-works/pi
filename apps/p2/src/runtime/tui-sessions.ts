// What optional plugins add to the TUI's session selector (p2-tui-port.md section 1.17): the subagents plugin its
// subagent conversations (threaded sort), the search plugin literal message matches. A registry, so the sessions
// plugin does not depend on either (it works without them loaded).

import { keyedRegistry } from "./chord.ts";
import type { TuiRuntime } from "./tui.ts";
import type { TuiContext } from "./tui-context.ts";

export type SessionChild = { name: string; conversationId: number; model: string };
export type SessionHit = {
	session: string;
	conversationId: number;
	role: "user" | "assistant";
	text: string;
	title: string;
};
export type TuiSessionSource = {
	/** Named subagent conversations by session ID, as they change; returns the stop function. */
	children?(runtime: TuiRuntime, onChange: (children: Readonly<Record<string, SessionChild[]>>) => void): () => void;
	/** Literal message matches for a query (owner). */
	search?(runtime: TuiRuntime, query: string, archived: boolean): Promise<SessionHit[]>;
};
export const TuiSessionSources = keyedRegistry<TuiSessionSource>("p2.tui-session-sources");

/**
 * Where the viewed session runs, and moving it (the sessions plugin): `/envs` (the envs plugin) marks the session's
 * environment and moves the session on Enter without depending on the sessions plugin.
 */
export type TuiSessionPlace = {
	/** The viewed session's environment (null: this device) and directory; undefined without a session. */
	where(ctx: TuiContext): { env: string | null; cwd: string } | undefined;
	/** Moves the viewed session to `env`: the directory prompt there (its note confirms), then `Sessions.relocate`. */
	moveTo(ctx: TuiContext, env: string | null): Promise<void>;
};
export const TuiSessionPlaces = keyedRegistry<TuiSessionPlace>("p2.tui-session-places");
