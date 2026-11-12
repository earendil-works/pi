import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
	type CSSProperties,
	createContext,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ActivityRow } from "./activity/ActivityRow.tsx";
import { ActivityLayer } from "./activity/ActivitySheet.tsx";
import {
	type ChatItem,
	chatItems,
	DEFAULT_DETAIL,
	type Detail,
	type ToolActivityTable,
	wheelThought,
} from "./activity/model.ts";
import { Results } from "./activity/Results.tsx";
import { handoff, type SlotHeights, SlotHeightsContext } from "./activity/ThoughtSlot.tsx";
import { CopyButton } from "./Code.tsx";
import { BranchFrom, OpenConversation, OpenPeerConversation, ReplyTo, RevealEntry } from "./chat-context.ts";
import {
	AlertIcon,
	BotIcon,
	BranchIcon,
	ChevronIcon,
	CommentIcon,
	PencilIcon,
	ReplyIcon,
	SparkIcon,
	UsersIcon,
} from "./icons.tsx";
import { imageSize } from "./image-size.ts";
import { useLongPress } from "./long-press.ts";
import { Markdown } from "./Markdown.tsx";
import { RowEstimator, type RowFeatures } from "./row-estimate.ts";
import { Time } from "./Time.tsx";
import type { Item, Transcript } from "./transcript.ts";
import { type RowRange, revealInTranscripts, type TranscriptScroll } from "./use-chat-scroll.ts";

function tokens(count: number): string {
	return count < 1000
		? String(count)
		: count < 1_000_000
			? `${(count / 1000).toFixed(1)}k`
			: `${(count / 1e6).toFixed(2)}M`;
}

/** The context bar; without `used` and `limit` (not known yet) a loading skeleton of it, in the same space. */
export function ContextUsage({ used, limit }: { used?: number; limit?: number }) {
	if (used === undefined || limit === undefined)
		return (
			<output className="context-usage pending" aria-label="Loading the context usage" aria-busy="true">
				<span className="context-track" />
				{/* The numbers' text, invisible under its skeleton: the same box as the numbers that replace it. */}
				<span className="usage skeleton-text" aria-hidden="true">
					00%/000k
				</span>
			</output>
		);
	const percent = Math.round((used / limit) * 100);
	const filled = Math.min(100, Math.max(0, percent));
	return (
		<div className="context-usage">
			<progress
				className="context-track"
				aria-label="Estimated active context usage"
				value={filled}
				max={100}
				aria-valuetext={`${percent}% of ${limit.toLocaleString()} tokens`}
			>
				{percent}%
			</progress>
			<span
				className="usage"
				title={`Estimated active context: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`}
			>
				{percent}%/{tokens(limit).replace(".0k", "k")}
			</span>
		</div>
	);
}

// The chat's contexts live in chat-context.ts (the activity uses them too); re-exported here for plugins.
export {
	BranchFrom,
	OneShotAgents,
	OpenConversation,
	OpenPeerConversation,
	OpenTerminal,
	OpenWorkspaceFile,
	ReplyTo,
	RevealEntry,
	relativePath,
	SessionId,
	ToolActivityContext,
	WorkingDirectory,
} from "./chat-context.ts";

/** Loads the next page of a gap's missing entries; absent while nothing can load them. */
export const FillGap = createContext<((gap: Extract<Item, { type: "gap" }>["gap"]) => void) | undefined>(undefined);

/**
 * A gap's row, styled as the transcript's top edge: its entries load once it is rendered (the virtual list renders
 * rows near the viewport) and on a tap after a failed load.
 */
function GapRow({ item }: { item: Extract<Item, { type: "gap" }> }) {
	const fill = useContext(FillGap);
	const { gap, loading } = item;
	useEffect(() => fill?.(gap), [fill, gap]);
	return (
		<button
			type="button"
			className={`history-edge earlier${loading ? " loading" : ""}`}
			disabled={loading}
			aria-busy={loading}
			onClick={() => fill?.(gap)}
		>
			<span className="spinner" aria-hidden="true" />
			Load more
		</button>
	);
}

/** Shows an entry, loading older history first when it is not loaded yet (`reveal`), then waiting for its render. */
export async function revealEntry(
	entryId: number,
	reveal: ((entryId: number) => Promise<boolean>) | undefined,
): Promise<boolean> {
	if (jumpToEntry(entryId)) return true;
	if (!reveal || !(await reveal(entryId))) return false;
	for (let frame = 0; frame < 60; frame++) {
		await new Promise((resolve) => requestAnimationFrame(resolve));
		if (jumpToEntry(entryId)) return true;
	}
	return false;
}

/** A message to show once its conversation is open (a search hit), consumed by that conversation's view. */
let pendingReveal: { session: string; conversation: number; entryId: number } | undefined;
let revealRequests = 0;
const revealListeners = new Set<() => void>();
export function requestReveal(session: string, conversation: number, entryId: number): void {
	pendingReveal = { session, conversation, entryId };
	revealRequests++;
	for (const listener of [...revealListeners]) listener();
}
/** Changes with every request (a `useSyncExternalStore` source), so an open conversation sees a hit in itself. */
export const revealRequest = {
	subscribe(listener: () => void): () => void {
		revealListeners.add(listener);
		return () => revealListeners.delete(listener);
	},
	count: (): number => revealRequests,
};
/** The pending message of this conversation, taken once its history is there. */
export function takeReveal(session: string, conversation: number, loaded: boolean): number | undefined {
	if (!loaded || pendingReveal?.session !== session || pendingReveal.conversation !== conversation) return undefined;
	const { entryId } = pendingReveal;
	pendingReveal = undefined;
	return entryId;
}

/**
 * Scrolls an entry's item into view and highlights it briefly. False when that entry is not loaded. The transcript
 * renders only the rows near the viewport, so the entry is found in its rows, not in the DOM.
 */
export function jumpToEntry(entryId: number): boolean {
	return revealInTranscripts(entryId);
}

/**
 * How to start a reply to one message: a button that shows on hover (hidden for coarse pointers), and a long press on
 * touch screens. Nothing when replies are off or the item has no entry yet.
 */
function useReply(entryId: number | undefined, name: string) {
	const reply = useContext(ReplyTo);
	const press = useLongPress(() => {
		if (reply && entryId !== undefined) reply({ entryId, name });
	});
	if (!reply || entryId === undefined) return { button: null, gesture: {} };
	const start = () => reply({ entryId, name });
	return {
		button: (
			<button type="button" className="reply-button" aria-label={`Reply to ${name}`} onClick={start}>
				<ReplyIcon />
			</button>
		),
		gesture: press.handlers,
	};
}

// Items, tools and their images keep their identity while unchanged (transcript.ts), so these memoized components
// skip rendering when a streaming delta changes only the live message.
const Images = memo(function Images({ images }: { images: ImageContent[] }) {
	if (!images.length) return null;
	return (
		<div className="images">
			{images.map((image, index) => (
				<img
					key={`${image.mimeType}-${index}`}
					src={`data:${image.mimeType};base64,${image.data}`}
					alt=""
					decoding="async"
					style={imageBox(image)}
				/>
			))}
		</div>
	);
});

const IMAGE_MAX_HEIGHT = 320;
const imageBoxes = new WeakMap<ImageContent, CSSProperties | undefined>();
/**
 * The box an image takes once decoded (its pixel size within the column's width and `.images img`'s max-height), so
 * decoding never resizes the transcript under the reader. Images keep their identity while unchanged: computed once.
 */
function imageBox(image: ImageContent): CSSProperties | undefined {
	if (imageBoxes.has(image)) return imageBoxes.get(image);
	const size = imageSize(image.data);
	const box = size && {
		width: `min(100%, ${size.width}px, ${(IMAGE_MAX_HEIGHT * size.width) / size.height}px)`,
		aspectRatio: `${size.width} / ${size.height}`,
	};
	imageBoxes.set(image, box);
	return box;
}

/** Whether a response ends with a notice (an error, a stop, the length limit) below its parts. */
function hasNotice(message: AssistantMessage, streaming: boolean): boolean {
	return ["error", "aborted", "length"].includes(message.stopReason) && !streaming;
}

/** Height of images whose boxes are known from their headers (`imageBox`), at most `width` wide. */
function imagesHeight(images: readonly ImageContent[], width: number): number {
	let height = 0;
	for (const image of images) {
		const size = imageSize(image.data);
		if (size)
			height +=
				(Math.min(width, size.width, (IMAGE_MAX_HEIGHT * size.width) / size.height) * size.height) / size.width;
	}
	return height;
}

/**
 * What a row's height depends on, for estimating rows never rendered (`RowEstimator`): its kind (the shape of its
 * item), its text length, and its images, whose boxes are exact.
 */
function rowFeatures(row: TranscriptRow, width: number): RowFeatures {
	const { item } = row;
	const spacing = row.first ? "first" : (row.gap ?? "");
	switch (item.type) {
		case "user":
			return {
				kind: [
					incoming(item) ? "incoming" : "user",
					item.author ? "named" : "",
					item.images.length ? "images" : "",
					// The owner's sent messages have a line of actions (Copy, the time) below the bubble; queued ones not yet.
					!incoming(item) && item.entryId !== undefined ? "actions" : "",
					spacing,
				].join(":"),
				text: item.text.length,
				fixed: imagesHeight(item.images, width),
			};
		case "activity": {
			const thought = wheelThought(item.entries ?? [], item.working);
			// A working wheel may also carry up to three lines of its latest thought.
			return item.rows
				? { kind: `activity:rows:${item.steps.length}:${spacing}`, text: 0, fixed: 0 }
				: {
						kind: `activity:${thought ? "thought:" : ""}${spacing}`,
						text: Math.min(thought?.text.length ?? 0, 300),
						fixed: 0,
					};
		}
		case "thought":
			// One line until opened; at detail 4 in full.
			return item.full
				? { kind: `thought:full:${spacing}`, text: item.text.length, fixed: 0 }
				: { kind: `thought:${spacing}`, text: 0, fixed: 0 };
		case "text":
			return { kind: `text:${spacing}`, text: item.text.length, fixed: 0 };
		case "answer":
			return {
				kind: [
					"answer",
					item.streaming ? "live" : hasNotice(item.message, item.streaming) ? "notice" : "",
					spacing,
				].join(":"),
				text: item.text.length,
				fixed: 0,
			};
		case "results":
			return { kind: `results:${item.tools.length}:${spacing}`, text: 0, fixed: 0 };
		case "failure":
			return { kind: `failure:${spacing}`, text: item.text.length, fixed: 0 };
		case "marker":
			return { kind: `marker:${spacing}`, text: 0, fixed: 0 };
		case "gap":
			return { kind: `gap:${spacing}`, text: 0, fixed: 0 };
	}
}

/**
 * Estimates for transcript rows never rendered, learned from the rows that were (`RowEstimator`); shared by every
 * transcript, since they share the stylesheet. A row of a kind not measured yet starts at about two lines of text.
 */
export const rowEstimates = new RowEstimator<TranscriptRow>(rowFeatures, 120);

/** Whether a message is someone else's (a subagent's, another session's, a guest's): `Incoming`, not a bubble. */
const incoming = (item: Extract<Item, { type: "user" }>): boolean =>
	Boolean(item.agent || item.peer || item.author?.kind === "guest");

const AGENT_VERBS = { answered: "answered", question: "asks", note: "wrote", failed: "failed" } as const;

/**
 * Someone else's message, one shape for every kind (owner decision: kinds differ only by icon and word, no coloured
 * edges): a header line "icon name · what · time", muted but the name, and the body as Markdown indented under the
 * name, cut after about eight lines with "Show more". The whole header opens where the message came from (a subagent's
 * conversation, another session) and then shows a chevron; the body is text to select, never a link.
 */
function Incoming({ item }: { item: Extract<Item, { type: "user" }> }) {
	const openConversation = useContext(OpenConversation);
	const openPeer = useContext(OpenPeerConversation);
	const reveal = useContext(RevealEntry);
	const branch = useContext(BranchFrom);
	const guest = item.author?.kind === "guest" ? item.author : undefined;
	const reply = useReply(guest ? item.entryId : undefined, guest?.name ?? "");
	const { agent, peer } = item;
	const sender: { kind: string; icon: ReactNode; name: string; what: string; open?: () => void } = agent
		? {
				kind: "agent",
				icon: agent.intent === "failed" ? <AlertIcon /> : <BotIcon />,
				name: agent.from.name,
				what: AGENT_VERBS[agent.intent],
				open: () => openConversation(agent.from.conversationId),
			}
		: peer
			? {
					kind: "session",
					icon: <CommentIcon />,
					name: peer.title.trim() || "Conversation",
					what: "wrote",
					...(openPeer ? { open: () => openPeer(peer.id) } : {}),
				}
			: {
					kind: "guest",
					icon: <UsersIcon />,
					name: guest?.name ?? "",
					what: item.chat ? "(guest) wrote in chat" : "(guest) wrote",
				};
	// Only what reached the agent can be edited, and a subagent's message is the agent's, not a person's.
	const entryId = item.chat || agent ? undefined : item.entryId;
	const line = (
		<>
			<span className="incoming-icon">{sender.icon}</span>
			<span className="incoming-line">
				<span className="incoming-name">{sender.name}</span> · {sender.what}
				{item.at !== undefined && (
					<>
						{" · "}
						<Time at={item.at} />
					</>
				)}
			</span>
		</>
	);
	return (
		<div className="incoming" data-entry={item.entryId} data-from={sender.kind} data-testid="incoming">
			<div className="incoming-head">
				{sender.open ? (
					<button type="button" className="incoming-from" aria-label={`Open ${sender.name}`} onClick={sender.open}>
						{line}
						<span className="incoming-chevron" aria-hidden="true">
							<ChevronIcon />
						</span>
					</button>
				) : (
					<div className="incoming-from">{line}</div>
				)}
				{branch && entryId !== undefined && (
					<button
						type="button"
						className="edit-button"
						aria-label="Edit"
						title="Edit: continue the session before this message, with its text in the composer"
						onClick={() => branch(entryId)}
					>
						<PencilIcon />
					</button>
				)}
				{reply.button}
			</div>
			<div className="incoming-content" {...reply.gesture}>
				{item.replyTo && (
					<button
						type="button"
						className="reply-quote"
						title="Show the message this answers"
						onClick={() => item.replyTo && void revealEntry(item.replyTo.entryId, reveal)}
					>
						<ReplyIcon size={12} />
						<strong>{item.replyTo.name}</strong> {item.replyTo.excerpt}
					</button>
				)}
				<Clamped text={item.text}>
					{agent?.intent === "failed" ? (
						<div className="incoming-plain">{item.text}</div>
					) : (
						<Markdown text={item.text} />
					)}
				</Clamped>
				{item.files.length > 0 && (
					<div className="bubble-files">
						{item.files.map((file) => (
							<span key={file}>{file}</span>
						))}
					</div>
				)}
				<Images images={item.images} />
				{item.note && <div className="bubble-note">{item.note}</div>}
			</div>
		</div>
	);
}

/** A body cut after about eight lines, with "Show more" when it is longer; `text` names what it shows. */
function Clamped({ text, children }: { text: string; children: ReactNode }) {
	const body = useRef<HTMLDivElement>(null);
	const [long, setLong] = useState(false);
	const [open, setOpen] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the text changes.
	useLayoutEffect(() => {
		const element = body.current;
		if (element && !open) setLong(element.scrollHeight > element.clientHeight + 1);
	}, [text, open]);
	return (
		<>
			<div className={`incoming-body ${open ? "" : "clamped"}`} ref={body}>
				{children}
			</div>
			{long && (
				<button type="button" className="incoming-more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? "Show less" : "Show more"}
				</button>
			)}
		</>
	);
}

/** The owner's message (or an input without an author): a bubble. People's messages can be replied to. */
function UserMessage({ item }: { item: Extract<Item, { type: "user" }> }) {
	const reveal = useContext(RevealEntry);
	const reply = useReply(item.author ? item.entryId : undefined, item.author?.name ?? "");
	const branch = useContext(BranchFrom);
	// Only what reached the agent can be edited: a chat message (chat mode) is not part of its history.
	const entryId = item.chat ? undefined : item.entryId;
	const edit = branch && entryId !== undefined;
	const text = item.text.trim();
	return (
		<div className={`user ${item.chat ? "chat-message" : ""}`} data-entry={item.entryId}>
			<div className="user-line">
				{reply.button}
				<div className="bubble" {...reply.gesture}>
					{item.replyTo && (
						<button
							type="button"
							className="reply-quote"
							title="Show the message this answers"
							onClick={() => item.replyTo && void revealEntry(item.replyTo.entryId, reveal)}
						>
							<ReplyIcon size={12} />
							<strong>{item.replyTo.name}</strong> {item.replyTo.excerpt}
						</button>
					)}
					{item.author && (
						<div className="speaker">
							{item.author.name}
							{item.chat && " · chat"}
						</div>
					)}
					{item.text}
					{item.files.length > 0 && (
						<div className="bubble-files">
							{item.files.map((file) => (
								<span key={file}>{file}</span>
							))}
						</div>
					)}
					<Images images={item.images} />
					{item.note && <div className="bubble-note">{item.note}</div>}
				</div>
			</div>
			{/* Sent messages only: a queued one has neither its entry nor its time yet. */}
			{item.entryId !== undefined && (text || item.at !== undefined || edit) && (
				<div className="message-actions">
					{item.at !== undefined && <Time at={item.at} className="message-time" />}
					{edit && (
						<button
							type="button"
							className="copy"
							aria-label="Edit"
							title="Edit: continue the session before this message, with its text in the composer"
							onClick={() => branch(entryId)}
						>
							<PencilIcon />
						</button>
					)}
					{text && <CopyButton text={text} />}
				</div>
			)}
		</div>
	);
}

/** A thinking block in place: "Thought", opened to its text with a tap; "Thinking…" while it streams. */
function Thought({ item }: { item: Extract<ChatItem, { type: "thought" }> }) {
	// Open at detail 4 (settings.json), also when the setting changes while it shows, until the reader toggles it.
	const [toggled, setOpen] = useState<boolean>();
	const open = toggled ?? Boolean(item.full);
	return (
		<div className={`thinking ${item.live ? "live" : ""}`} data-entry={item.entryId} data-testid="thought">
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<SparkIcon size={15} />
				<span>{item.live ? "Thinking…" : "Thought"}</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={14} />
				</span>
			</button>
			{open && <div className="thinking-body">{item.text}</div>}
		</div>
	);
}

/**
 * The agent's answer: the last text of its turn, as prose, with Copy, Branch, Reply and its time once complete; a stop,
 * an error or the length limit below it.
 */
const Answer = memo(function Answer({ item }: { item: Extract<ChatItem, { type: "answer" }> }) {
	const reply = useReply(item.streaming ? undefined : item.entryId, "Pi");
	const branch = useContext(BranchFrom);
	const { message, entryId } = item;
	const text = item.text.trim();
	return (
		<div className="assistant" data-entry={entryId} {...reply.gesture}>
			{text && (
				<div className={item.streaming ? "streaming" : undefined}>
					<Markdown text={item.text} />
					{!item.streaming && (
						<div className="message-actions">
							<CopyButton text={text} />
							{branch && entryId !== undefined && (
								<button
									type="button"
									className="copy"
									aria-label="Branch from here"
									title="Branch from here: continue the session after this answer"
									onClick={() => branch(entryId)}
								>
									<BranchIcon />
								</button>
							)}
							{reply.button}
							<Time at={message.timestamp} className="message-time" />
						</div>
					)}
				</div>
			)}
			{hasNotice(message, item.streaming) && (
				<div className={`notice ${message.stopReason === "aborted" ? "stopped" : "error"}`}>
					{message.stopReason === "aborted"
						? "Stopped"
						: message.stopReason === "length"
							? "The response hit the model's length limit"
							: message.errorMessage || "The provider returned an error."}
				</div>
			)}
		</div>
	);
});

const ItemView = memo(function ItemView({ item }: { item: ChatItem }) {
	switch (item.type) {
		case "user":
			return incoming(item) ? <Incoming item={item} /> : <UserMessage item={item} />;
		case "thought":
			return <Thought item={item} />;
		case "text":
			return (
				<div className="assistant" data-entry={item.entryId}>
					<Markdown text={item.text} />
				</div>
			);
		case "activity":
			return (
				<ActivityRow
					rowKey={item.key}
					steps={item.steps}
					{...(item.entries ? { entries: item.entries } : {})}
					{...(item.rows ? { rows: true } : {})}
					working={item.working}
					{...(item.startedAt ? { startedAt: item.startedAt } : {})}
					{...(item.endedAt ? { endedAt: item.endedAt } : {})}
				/>
			);
		case "answer":
			return <Answer item={item} />;
		case "results":
			return <Results tools={item.tools} />;
		case "failure":
			return <output className="notice error">{item.text}</output>;
		case "marker":
			return (
				<details className="marker">
					<summary>{item.label}</summary>
					{item.detail && <Markdown text={item.detail} />}
				</details>
			);
		case "gap":
			return <GapRow item={item} />;
	}
});

/** A transcript row: a chat item, and its spacing to the row before it. */
export type TranscriptRow = {
	key: string;
	entryId?: number;
	/** The responses a turn's activity row shows, for revealing one of them. */
	entryIds?: readonly number[];
	item: ChatItem;
	first: boolean;
	/**
	 * The spacing to the row before: a turn's parts (thinking, words, runs of calls, the answer, its results) follow each
	 * other closely (`step`); everything else (a person's message, the first part after it, markers) starts a new turn.
	 */
	gap?: "step";
	/**
	 * The first part of the agent's turn: at least one row tall, as the working wheel it replaces (a first line of
	 * words is shorter), so the turn never shrinks when its first part arrives.
	 */
	lead?: boolean;
};

/** The parts of the agent's turn, which follow each other at the step distance. */
const TURN_PARTS: ReadonlySet<ChatItem["type"]> = new Set(["thought", "text", "activity", "answer", "results"]);

/** Rows keep their identity while their item and spacing are unchanged. */
const rowsOf = new WeakMap<ChatItem, { first: boolean; gap: TranscriptRow["gap"]; row: TranscriptRow }>();
/**
 * The rows of a transcript: its items as the chat shows them (`chatItems`: each turn's thinking, texts and runs of
 * calls in order, its answer and results). `tools`: the tools' contributions (`ToolActivities`); `detail`: how much
 * of a turn the transcript shows (settings.json `detail`).
 * `working`: the agent is at it, so the last turn is live; `known`: `working` comes from the server's live state (not
 * yet while the transcript kept on this device shows).
 */
export function transcriptRows(
	items: readonly Item[],
	tools: ToolActivityTable,
	working = false,
	known = true,
	detail: Detail = DEFAULT_DETAIL,
): TranscriptRow[] {
	const shown = chatItems(items, working, known, tools, detail);
	return shown.map((item, index) => {
		const first = index === 0;
		const before = shown[index - 1];
		const gap = before && TURN_PARTS.has(before.type) && TURN_PARTS.has(item.type) ? ("step" as const) : undefined;
		const cached = rowsOf.get(item);
		if (cached && cached.first === first && cached.gap === gap) return cached.row;
		const row: TranscriptRow = {
			key: item.key,
			...("entryId" in item && item.entryId !== undefined ? { entryId: item.entryId } : {}),
			...(item.type === "activity" && item.entryIds?.length ? { entryIds: item.entryIds } : {}),
			item,
			first,
			...(gap ? { gap } : {}),
			...(!gap && TURN_PARTS.has(item.type) ? { lead: true } : {}),
		};
		rowsOf.set(item, { first, gap, row });
		return row;
	});
}

/** Rows arriving together fade in one after another, this far apart, all within `ENTER_LAST`. */
const ENTER_STAGGER = 45;
const ENTER_LAST = 360;
/** How long a row counts as arriving (its animation's length and delay): mounted again later, it does not animate. */
const ENTER_FOR = 1_000;

/**
 * Rows that just arrived at the end of the transcript, with their animation delays: new messages fade in instead of
 * appearing at once (a burst after reconnecting one after another). Only rows appended after the previous last row
 * while the list grows: not the first rows (opening a conversation, the transcript kept on the device), not older
 * history above, not a row replaced in place (a streaming answer committed, a sent message the server now shows), and
 * not a row the virtual list mounts again while scrolling.
 */
function useArriving(rows: readonly TranscriptRow[]): ReadonlyMap<string, number> {
	const state = useRef<{ rows: readonly TranscriptRow[]; arriving: Map<string, { delay: number; until: number }> }>(
		undefined,
	);
	const now = performance.now();
	const current = state.current;
	if (!current) {
		state.current = { rows, arriving: new Map() };
		return new Map();
	}
	if (current.rows !== rows) {
		const last = current.rows.at(-1);
		if (last && rows.length > current.rows.length) {
			let at = rows.length - 1;
			while (at >= 0 && rows[at]?.key !== last.key) at--;
			const added = at >= 0 ? rows.slice(at + 1) : [];
			added.forEach((row, index) => {
				if (current.arriving.has(row.key)) return;
				const delay = Math.min(index * ENTER_STAGGER, ENTER_LAST);
				current.arriving.set(row.key, { delay, until: now + delay + ENTER_FOR });
			});
		}
		current.rows = rows;
	}
	const delays = new Map<string, number>();
	for (const [key, { delay, until }] of current.arriving) {
		if (until < now) current.arriving.delete(key);
		else delays.set(key, delay);
	}
	return delays;
}

// The composer re-renders App on every keypress; a long transcript must only
// re-render when the view changes. Only the rows in `range` are rendered (use-chat-scroll.ts); spacers stand for the
// others.
export const Messages = memo(function Messages({
	transcript,
	rows,
	list,
	range,
	stopped = false,
	earlier,
	onEarlier,
}: {
	transcript: Transcript;
	rows: readonly TranscriptRow[];
	list: TranscriptScroll;
	range: RowRange;
	stopped?: boolean;
	/**
	 * The loaded history's top edge: older history exists ("more"), is being fetched ("loading"), or every page was
	 * loaded ("start").
	 */
	earlier?: "more" | "loading" | "start";
	onEarlier?: () => void;
}) {
	const spacers = list.spacers(range);
	const arriving = useArriving(rows);
	const [slotHeights] = useState<SlotHeights>(() => new Map());
	return (
		<div className="messages">
			{/* One height in every state: the edge changing never moves the transcript under the reader. It loads ahead
			    of the reader (use-chat-scroll.ts), so the button is a fallback. */}
			{earlier === "start" ? (
				<div className="history-edge">Start of conversation</div>
			) : (
				earlier && (
					<button
						type="button"
						className={`history-edge earlier${earlier === "loading" ? " loading" : ""}`}
						disabled={earlier === "loading"}
						aria-busy={earlier === "loading"}
						onClick={onEarlier}
					>
						<span className="spinner" aria-hidden="true" />
						Earlier messages
					</button>
				)
			)}
			<div className="rows" ref={list.listRef} data-rows={rows.length}>
				<div className="row-space" ref={list.topRef} style={{ height: spacers.before }} />
				<SlotHeightsContext value={slotHeights}>
					{rows.slice(range.start, range.end + 1).map((row, offset) => {
						const index = range.start + offset;
						const delay = arriving.get(row.key);
						// The row after a finished wheel takes the place of its thought (activity/ThoughtSlot.tsx).
						const held = handoff(slotHeights, rows[index - 1], index === rows.length - 1, transcript.working);
						return (
							<div
								key={row.key}
								className={["row", row.first ? "first" : "", delay === undefined ? "" : "arriving"]
									.filter(Boolean)
									.join(" ")}
								style={
									delay || held !== undefined
										? {
												...(delay ? { animationDelay: `${delay}ms` } : {}),
												...(held === undefined ? {} : { minHeight: held }),
											}
										: undefined
								}
								data-row={row.key}
								data-gap={row.first ? undefined : row.gap}
								data-lead={row.lead ? "" : undefined}
								data-handoff={held === undefined ? undefined : held ? "held" : "released"}
								ref={list.rowRef}
							>
								<ItemView item={row.item} />
							</div>
						);
					})}
				</SlotHeightsContext>
				<div className="row-space" ref={list.bottomRef} style={{ height: spacers.after }} />
			</div>
			{stopped && !transcript.busy && <output className="notice stopped">Stopped</output>}
			{transcript.compactions.map((compaction) => (
				<output key={compaction.id} className="notice">
					{compaction.blocking ? "Compacting context…" : "Compacting context in background…"}
					{compaction.retry && ` Retrying: ${compaction.retry.error.slice(0, 200)}`}
				</output>
			))}
			{transcript.retry && (
				<div className="notice">Provider error, retrying… {transcript.retry.error.slice(0, 200)}</div>
			)}
			<ActivityLayer rows={rows} />
		</div>
	);
});
