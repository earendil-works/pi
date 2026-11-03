// What other TUI facets use of the chat plugin's surface (slot "chat"): chat mode's replies and send_file's downloads.
// They reach it through `chatSurface`, never the chat plugin's class: plugins share contracts, not code.

import type { Component } from "@earendil-works/pi-tui";
import type { ToolView } from "../web/transcript.ts";
import type { TuiContext } from "./tui-context.ts";

/** Marks the chat plugin's surface: a registered symbol, the same in every copy of the chat plugin's code. */
export const CHAT_SURFACE: unique symbol = Symbol.for("p2.chat-surface");

/** A message a reply can answer. */
export type ReplyTarget = { readonly entryId: number; readonly name: string; readonly excerpt: string };

export interface ChatSurfaceApi extends Component {
	readonly [CHAT_SURFACE]: true;
	/** The message the next send answers. */
	readonly replyTo: { entryId: number; name: string } | undefined;
	/** Chat mode switched replies on or off; `mentionName` is the agent's name to mention (default "Pi"). */
	setCanReply(enabled: boolean, mentionName?: string): void;
	/** The next send answers this entry (chat mode); undefined cancels. */
	setReplyTo(target: { entryId: number; name: string } | undefined): void;
	/** Messages a reply can answer: people's and Pi's committed messages, newest first. */
	replyTargets(): ReplyTarget[];
	/** The viewed conversation's finished calls of the tool `name`. */
	toolViews(name: string): ToolView[];
}

/** The mounted chat surface, if the chat plugin is loaded and shows one. */
export function chatSurface(ctx: TuiContext): ChatSurfaceApi | undefined {
	const surface = ctx.surface("chat");
	// `surface` is any slot's component: the brand tells the chat plugin's apart.
	return surface !== undefined && CHAT_SURFACE in surface ? (surface as ChatSurfaceApi) : undefined;
}
