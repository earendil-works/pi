// Chat mode in the browser: the composer's "Chat" chip, and chat entries in the transcript. While chat mode is on, a
// second chip shows how the agent is mentioned (`@pi`); the owner taps it to rename the agent for this conversation
// (what people type after `@`, and what voice mode listens for).

import { BACKGROUND_CONTEXT, defineFacet } from "@p2/app/v1";
import { Sheet, Slots, useComposerState, useObject, useReadable, useRoute, useStatus } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { TranscriptEntries } from "../chat/contract.ts";
import { ChatMode, DEFAULT_AGENT_NAME, mentionToken } from "./contract.ts";
import { CHAT_ENTRY_DISPLAYS } from "./display.ts";
import "./style.css";
import { contribute } from "@p2/app/v1";

const hint = (name: string) =>
	`Chat mode: messages go to the people in this session, not to ${name}. Mention ${mentionToken(name)} (or say "${name}") to ask ${name}; it then reads the chat since its last answer.`;

/** One word, as typed after `@` and spoken: letters, digits, `_` and `-`, starting with a letter (AgentNameSchema). */
const VALID_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** The owner's sheet for the agent's name in this conversation. */
function NameSheet({
	name,
	onSave,
	onClose,
}: {
	name: string;
	onSave: (name: string) => Promise<unknown>;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(name);
	const [error, setError] = useState<string>();
	const valid = VALID_NAME.test(draft.trim());
	const save = () => {
		const next = draft.trim();
		if (!VALID_NAME.test(next)) return;
		void onSave(next)
			.then(onClose)
			.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
	};
	return (
		<Sheet title="Agent name" onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}
			>
				<label className="field">
					<span className="label">Name in this conversation</span>
					<input
						className="input"
						value={draft}
						maxLength={32}
						autoCapitalize="words"
						autoCorrect="off"
						spellCheck={false}
						aria-invalid={!valid}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</label>
				<p className="muted small">
					People mention it as {mentionToken(valid ? draft.trim() : name)}, and in voice mode its name anywhere in
					what they say counts. One word: letters, digits, - and _.
				</p>
				{error && <p className="error small">{error}</p>}
				<div className="inline-form">
					<button type="submit" className="button" disabled={!valid || draft.trim() === name}>
						Save
					</button>
					{name !== DEFAULT_AGENT_NAME && (
						<button type="button" className="text-action" onClick={() => setDraft(DEFAULT_AGENT_NAME)}>
							Reset to {DEFAULT_AGENT_NAME}
						</button>
					)}
				</div>
			</form>
		</Sheet>
	);
}

/** Beside Steer in the composer: the owner's switch; for guests, a marker while chat mode is on. */
function ChatModeChip() {
	const route = useRoute();
	const { session } = route;
	const mode = useObject(ChatMode, session ? { session, conversation: route.conversation ?? 1 } : undefined);
	const live = useStatus(mode) === "live";
	const enabled = useReadable(mode?.enabled) ?? false;
	const waiting = useReadable(mode?.waiting) ?? 0;
	const name = useReadable(mode?.name) ?? DEFAULT_AGENT_NAME;
	const [renaming, setRenaming] = useState(false);
	const label = enabled && waiting ? `Chat · ${waiting}` : "Chat";
	// Replies belong to chat mode: the transcript offers them while it is on, and the composer offers the mention.
	const { setCanReply, setReplyTo, setMentionName } = useComposerState();
	const replies = live && enabled;
	useEffect(() => {
		setCanReply(replies);
		if (!replies) setReplyTo(undefined);
		return () => setCanReply(false);
	}, [replies, setCanReply, setReplyTo]);
	useEffect(() => {
		setMentionName(name);
		return () => setMentionName(DEFAULT_AGENT_NAME);
	}, [name, setMentionName]);
	if (!mode || !live) return null;
	const title = hint(name);
	if (mode.variant !== "owner")
		return enabled ? (
			<>
				<span className="chip on chat-mode" title={title}>
					{label}
				</span>
				<span className="chip chat-mode-name" title={title}>
					{mentionToken(name)}
				</span>
			</>
		) : null;
	return (
		<>
			<button
				type="button"
				className={`chip toggle chat-mode ${enabled ? "on" : ""}`}
				aria-pressed={enabled}
				title={title}
				onClick={() =>
					void mode.set({ enabled: !enabled }, BACKGROUND_CONTEXT).catch((error: unknown) => console.error(error))
				}
			>
				{label}
			</button>
			{enabled && (
				<button
					type="button"
					className="chip chat-mode-name"
					title={`Mentioned as ${mentionToken(name)}: rename`}
					aria-label={`Agent name ${name}. Rename`}
					onClick={() => setRenaming(true)}
				>
					{mentionToken(name)}
				</button>
			)}
			{renaming && (
				<NameSheet
					name={name}
					onSave={(next) => mode.rename({ name: next }, BACKGROUND_CONTEXT)}
					onClose={() => setRenaming(false)}
				/>
			)}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.chat-mode-web", (self) => {
		self.contribute(Slots, { "composer:chat-mode": ChatModeChip });
		self.contribute(TranscriptEntries, CHAT_ENTRY_DISPLAYS);
	});
});
