// Chat mode in the TUI (p2-tui-port.md P11b), after the web facet: chat and mention entries show their reply quote
// and note (the shared `TranscriptEntries` display), a composer chip shows the mode (the owner toggles it with
// `/chat-mode`), and while it is on `/reply` picks the message the next send answers and `@pi` completes first.

import type { Held, HeldIn } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn, statusOf } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	chatSurface,
	ListOverlay,
	type OptimisticAdd,
	type TuiCommand,
	TuiCommands,
	type TuiRuntime,
	TuiScope,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { TranscriptEntries } from "../chat/contract.ts";
import { ChatMode, DEFAULT_AGENT_NAME, mentionToken } from "./contract.ts";
import { CHAT_ENTRY_DISPLAYS } from "./display.ts";

const hint = (name: string) => `messages go to the people here; ${mentionToken(name)} asks ${name}`;

/** The `composer:chat-mode` chip: the viewed conversation's chat mode, and the reply switch of the chat surface. */
export class ChatModeChip implements TuiSurface {
	readonly runtime: TuiRuntime;
	private scope: TuiScope | undefined;
	private identity: string | undefined;
	private mode: Held<typeof ChatMode> | undefined;
	/** The switch the owner flipped while its call is in flight (`/chat-mode`). */
	/** The switch as shown (the owner's flip while its call is in flight) and how to flip it. */
	private shownEnabled: () => boolean = () => false;
	private switching: OptimisticAdd<boolean> | undefined;
	private enabledState = false;
	/** The agent's name in this conversation (what people mention). */
	name = DEFAULT_AGENT_NAME;
	private waiting = 0;
	private stop: () => void;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		const changed = (): void => {
			this.syncReplies();
			if (runtime.identity === this.identity) return;
			this.identity = runtime.identity;
			this.scope?.dispose();
			this.scope = undefined;
			this.mode = undefined;
			this.switching = undefined;
			this.shownEnabled = () => false;
			this.enabledState = false;
			this.waiting = 0;
			this.name = DEFAULT_AGENT_NAME;
			const session = runtime.session;
			if (!session) return;
			this.scope = new TuiScope(runtime);
			[this.shownEnabled, this.switching] = this.scope.optimistic(() => this.enabledState);
			this.mode = this.scope.watch(ChatMode, { session, conversation: runtime.conversation }, (ref, follow) => {
				follow(ref.enabled, (enabled) => {
					this.enabledState = enabled ?? false;
				});
				follow(ref.waiting, (waiting) => {
					this.waiting = waiting ?? 0;
				});
				follow(ref.name, (name) => {
					this.name = name ?? DEFAULT_AGENT_NAME;
				});
			});
		};
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		changed();
	}
	/** Whether chat mode is on, as shown: the owner's switch while its call is in flight, else the state. */
	get enabled(): boolean {
		return this.shownEnabled();
	}
	/** The owner's live reference (to switch the mode). */
	owner(): HeldIn<typeof ChatMode, "owner"> | undefined {
		return liveIn(this.mode, "owner");
	}
	/** Flips the mode: the chip shows it at once; a refused call flips it back and says why. */
	toggle(): void {
		const owner = this.owner();
		if (!owner || !this.switching) {
			this.runtime.notify("Chat mode is not available here", "warning");
			return;
		}
		const enabled = !this.enabled;
		this.runtime.perform(
			this.switching(enabled, owner.set({ enabled }, BACKGROUND_CONTEXT)).then(() =>
				this.runtime.notify(enabled ? `Chat mode on: ${hint(this.name)}` : "Chat mode off"),
			),
		);
	}
	private live(): boolean {
		return this.mode !== undefined && statusOf(this.mode) === "live";
	}
	/** Replies belong to chat mode (the web's `setCanReply`). */
	private syncReplies(): void {
		chatSurface(this.runtime.ctx)?.setCanReply(this.live() && this.enabled, this.name);
	}
	render(): string[] {
		const theme = this.runtime.theme.current;
		if (!this.live()) return [];
		const label = this.enabled && this.waiting ? `Chat · ${this.waiting}` : "Chat";
		if (this.enabled)
			return [`${theme.bg("selectedBg", theme.fg("accent", ` ${label} `))} ${theme.fg("dim", hint(this.name))}`];
		// Off: only the owner sees the switch.
		return this.owner() ? [theme.fg("dim", `[${label} off · /chat-mode]`)] : [];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		this.scope?.dispose();
	}
}

const CHIP = "composer:chat-mode";
const chipOf = (ctx: TuiContext): ChatModeChip | undefined => {
	const surface = ctx.surface(CHIP);
	return surface instanceof ChatModeChip ? surface : undefined;
};

/** `/reply`: the message the next send answers (a pick list, newest first); again with a target set, cancels. */
function reply(ctx: TuiContext): void {
	const chat = chatSurface(ctx);
	if (!chat) return;
	if (chat.replyTo) {
		chat.setReplyTo(undefined);
		ctx.notify("Reply cancelled");
		return;
	}
	const targets = chat.replyTargets();
	const handle = ctx.overlay(
		"reply",
		new ListOverlay(ctx, {
			title: "Reply to",
			rows: () =>
				targets.map((target) => ({
					key: String(target.entryId),
					label: `${target.name}: ${target.excerpt}`,
				})),
			onSelect: (row) => {
				handle.close();
				const target = targets.find((candidate) => String(candidate.entryId) === row.key);
				if (target) chat.setReplyTo({ entryId: target.entryId, name: target.name });
			},
			onClose: () => handle.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

export const CHAT_MODE_COMMANDS: Record<string, TuiCommand> = {
	"p2.chatMode.toggle": {
		title: "Toggle chat mode",
		category: "Chat",
		when: "chat && owner && !overlay",
		slash: { name: "chat-mode" },
		run: (ctx) => {
			const chip = chipOf(ctx);
			if (chip) chip.toggle();
			else ctx.notify("Chat mode is not available here", "warning");
		},
	},
	"p2.chatMode.reply": {
		title: "Reply to a message (chat mode)",
		category: "Chat",
		when: "chat && participant && canReply && !overlay",
		slash: { name: "reply" },
		run: (ctx) => reply(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-chat-mode", (self) => {
		self.contribute(TranscriptEntries, CHAT_ENTRY_DISPLAYS);
		self.contribute(TuiSlots, { [CHIP]: (runtime: TuiRuntime): TuiSurface => new ChatModeChip(runtime) });
		self.contribute(TuiCommands, CHAT_MODE_COMMANDS);
	}),
);
