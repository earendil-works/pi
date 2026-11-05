// Main view: the transcript of the open session with its composer, or the new-session screen.

import {
	Access,
	BACKGROUND_CONTEXT,
	defineFacet,
	expandComposerText,
	grantMode,
	type Held,
	isChordError,
	liveIn,
	serveKeyed,
	whenLive,
} from "@p2/app/v1";
import {
	AttachIcon,
	BranchFrom,
	buildTranscript,
	ChevronIcon,
	CloseIcon,
	CostPanel,
	closeLayers,
	conversationRoute,
	DownIcon,
	type FileCompletion,
	FileCompletionPopover,
	FillGap,
	FolderIcon,
	forgetSession,
	type Gap,
	type Kept,
	keep,
	keepSessions,
	keptSizes,
	loadKept,
	locationLabel,
	MenuIcon,
	Messages,
	type ModelChoice,
	ModelPicker,
	modelName,
	navigate,
	OneShotAgents,
	OpenConversation,
	OpenTerminal,
	OpenWorkspaceFile,
	openLayer,
	type PickedFile,
	PiLogo,
	PlusIcon,
	ReplyTo,
	RevealEntry,
	revealEntry,
	revealRequest,
	rowEstimates,
	SendIcon,
	SessionId,
	SessionStats,
	Slot,
	SlotList,
	Slots,
	StopIcon,
	seedSizes,
	setDrawer,
	setSidebarCollapsed,
	takeReveal,
	transcriptOf,
	transcriptRows,
	useChatScroll,
	useComposerState,
	useConnected,
	useFileCompletion,
	useHost,
	useNavigation,
	useNewSessionState,
	useObject,
	useOwner,
	useReadable,
	useRegistry,
	useRoute,
	useShareEnded,
	useSheet,
	useStatus,
	WorkingDirectory,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Drafts } from "../drafts/contract.ts";
import { DirectoryPicker, directoryPickerLayer } from "../envs/contract.web.tsx";
import { Models } from "../models/contract.ts";
import type { ResourceSnapshot } from "../models/resources.ts";
import { type Session, Sessions } from "../sessions/contract.ts";
import { SessionMetrics, SessionStatus, WorkerControl } from "../status/contract.ts";
import { type Child, conversationLocation, SubagentControl, Subagents } from "../subagents/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { Chat, ChatCosts, TranscriptEntries } from "./contract.ts";
import { type Outgoing, outboxOf } from "./outbox.ts";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An upload the server answered with an error status. */
class UploadError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** Uploads a file to the session (the files plugin's route); returns its upload ID. */
async function upload(session: string, file: File): Promise<string> {
	const query = new URLSearchParams({ session, name: file.name });
	const response = await fetch(`/upload?${query}`, { method: "POST", body: file, credentials: "same-origin" });
	const result = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
	if (!response.ok || !result.id)
		throw new UploadError(`Upload of ${file.name} failed: ${result.error ?? response.status}`, response.status);
	return result.id;
}

/**
 * Whether a failed send refuses the message for good: not allowed, invalid (a template that does not exist), an upload
 * the server rejects. Anything else (the connection, a restarting worker) is retried by the outbox.
 */
function refused(error: unknown): boolean {
	if (error instanceof UploadError) return error.status >= 400 && error.status < 500;
	return (
		isChordError(error) &&
		["forbidden", "invalid", "not_in_variant", "contract_mismatch", "upgrade_required"].includes(error.code)
	);
}

/** Picked files: shown above the textarea, removable; the attach button and pasted images add more. */
type Attaching = {
	readonly files: readonly PickedFile[];
	readonly add: (files: File[]) => void;
	readonly remove: (file: PickedFile) => void;
};

/**
 * The images a paste attaches, or none to leave the paste to the textarea. Plain text wins: Office apps put a rendered
 * picture of the copied cells beside the text, and Chrome on macOS pastes a Finder file as its icon beside its name.
 */
function pastedImages(data: DataTransfer): File[] {
	if (data.getData("text/plain") !== "") return [];
	return [...data.items]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((file) => file !== null)
		.map((file) =>
			// The server infers an upload's image type from its extension; a nameless paste gets one from its type.
			/\.[a-z0-9]+$/i.test(file.name)
				? file
				: new File([file], `pasted-image.${file.type.slice(6).replace("jpeg", "jpg")}`, { type: file.type }),
		);
}

/** The composer's attachments from its state. */
const attachingOf = ({ files, setFiles, addFiles }: ReturnType<typeof useComposerState>): Attaching => ({
	files,
	add: addFiles,
	remove: (file) => setFiles((current) => current.filter((entry) => entry !== file)),
});

/** The model and thinking chip that opens the model sheet. */
function ModelControl({ resources, choice }: { resources: ResourceSnapshot | undefined; choice?: ModelChoice }) {
	const name = choice ? modelName(resources, choice.model) : "Choose model";
	const level = choice && choice.thinkingLevel !== "off" ? choice.thinkingLevel : undefined;
	return (
		<button
			type="button"
			className="model-control footer-action"
			aria-label="Model and thinking"
			title={`${name}${level ? ` · ${level}` : ""}`}
			onClick={() => openLayer({ kind: "sheet", name: "model" })}
			disabled={!resources}
		>
			<span>
				{name}
				{level && ` · ${level}`}
			</span>
		</button>
	);
}

/** The composer's error; tapping it dismisses it. */
function ErrorToast({ error, onDismiss }: { error: string | undefined; onDismiss: () => void }) {
	return error ? (
		<button type="button" className="toast" onClick={onDismiss}>
			{error}
		</button>
	) : null;
}

/** Textarea with send, stop, steer and attachments; Enter sends with a fine pointer, Escape stops. */
function Composer({
	draft,
	setDraft,
	busy,
	steer,
	setSteer,
	disabled,
	onSend,
	onStop,
	attaching,
	replying,
	completion,
	textareaRef,
	children,
}: {
	draft: string;
	setDraft: (text: string) => void;
	busy: boolean;
	steer: boolean;
	setSteer: (steer: boolean) => void;
	disabled: boolean;
	onSend: () => void;
	onStop?: () => void;
	attaching?: Attaching;
	/** The message being answered, shown above the text with a way to drop the reply. */
	replying?: { name: string; onCancel: () => void };
	/** `@` and Tab file completion (p2 addition, src/web/file-completion.tsx); only where a session exists. */
	completion?: FileCompletion;
	textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
	children?: React.ReactNode;
}) {
	const ownRef = useRef<HTMLTextAreaElement>(null);
	const textarea = textareaRef ?? ownRef;
	// biome-ignore lint/correctness/useExhaustiveDependencies: resizing follows the rendered draft, as in Pi Mobile.
	useLayoutEffect(() => {
		const element = textarea.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.overflowY = "hidden";
		element.style.height = `${Math.min(element.scrollHeight + 1, 200)}px`;
		element.style.overflowY = element.scrollHeight > element.clientHeight ? "auto" : "hidden";
	}, [draft]);
	const files = attaching?.files ?? [];
	const content = draft.trim() !== "" || files.length > 0;
	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				onSend();
			}}
		>
			{replying && (
				<div className="replying">
					<span>
						Replying to <strong>{replying.name}</strong>
					</span>
					<button type="button" aria-label="Cancel reply" onClick={replying.onCancel}>
						<CloseIcon />
					</button>
				</div>
			)}
			{files.length > 0 && (
				<div className="attachments">
					{files.map((file) => (
						<span key={file.key} className="attachment">
							{file.preview ? <img src={file.preview} alt="" /> : <AttachIcon />}
							<span className="attachment-name">{file.file.name}</span>
							<button
								type="button"
								aria-label={`Remove ${file.file.name}`}
								onClick={() => attaching?.remove(file)}
							>
								<CloseIcon />
							</button>
						</span>
					))}
				</div>
			)}
			{completion && <FileCompletionPopover completion={completion} />}
			<textarea
				ref={textarea}
				rows={1}
				value={draft}
				placeholder={busy ? (steer ? "Steer the current run…" : "Queue a follow-up…") : "Message Pi…"}
				aria-label="Message"
				onChange={(event) => {
					setDraft(event.target.value);
					completion?.update();
				}}
				onClick={() => completion?.update()}
				onPaste={(event) => {
					if (!attaching) return;
					const images = pastedImages(event.clipboardData);
					if (!images.length) return;
					event.preventDefault();
					attaching.add(images);
				}}
				onFocus={() => completion?.onFocus()}
				onBlur={() => completion?.onBlur()}
				onCompositionStart={() => completion?.onCompositionStart()}
				onCompositionEnd={() => completion?.onCompositionEnd()}
				onKeyDown={(event) => {
					// An open completion popover owns Enter, Tab, the arrows and Escape (section 8.4).
					if (completion?.onKeyDown(event)) return;
					if (event.key === "Escape" && busy && onStop) {
						event.preventDefault();
						onStop();
						return;
					}
					if (event.key === "Enter" && !event.shiftKey && window.matchMedia("(pointer: fine)").matches) {
						event.preventDefault();
						onSend();
					}
				}}
			/>
			<div className="composer-bar">
				{attaching && (
					<label className="round attach" aria-label="Attach files" title="Attach files">
						<PlusIcon />
						<input
							type="file"
							multiple
							hidden
							onChange={(event) => {
								attaching.add([...(event.target.files ?? [])]);
								event.target.value = "";
							}}
						/>
					</label>
				)}
				{busy && (
					<button
						type="button"
						className={`chip toggle ${steer ? "on" : ""}`}
						aria-pressed={steer}
						onClick={() => setSteer(!steer)}
					>
						Steer
					</button>
				)}
				{children}
				<span className="spacer" />
				{busy && onStop && (
					<button type="button" className="round stop" aria-label="Stop" onClick={onStop}>
						<StopIcon />
					</button>
				)}
				{(!busy || content) && (
					<button type="submit" className="round send" aria-label="Send" disabled={!content || disabled}>
						<SendIcon />
					</button>
				)}
			</div>
		</form>
	);
}

function TopBar({ session, child, owner = false }: { session?: Session; child?: Child; owner?: boolean }) {
	const connected = useConnected();
	const nav = useNavigation();
	const route = useRoute();
	return (
		<header className="topbar">
			<button
				type="button"
				className="icon-button menu sidebar-open"
				onClick={() =>
					window.matchMedia("(min-width: 900px)").matches ? setSidebarCollapsed(false) : setDrawer(true)
				}
				aria-label="Sessions"
			>
				<MenuIcon />
			</button>
			<div className="title">
				{child ? (
					<>
						<h1>
							<span className="sub-tag">{child.kind === "agent" ? "agent" : "subagent"}</span> {child.name}
						</h1>
						<button
							type="button"
							className="crumb"
							onClick={() => session && void nav.backOrPush(conversationRoute(route, session.id, session.main))}
						>
							← {session?.title}
						</button>
					</>
				) : (
					<>
						<h1>{session?.title ?? "New session"}</h1>
						{session &&
							(owner ? (
								<button
									type="button"
									className="title-cwd"
									onClick={() => openLayer(directoryPickerLayer(session.env ?? null, session.cwd))}
								>
									{locationLabel(session.env, session.cwd)}
								</button>
							) : (
								<p>{locationLabel(session.env, session.cwd)}</p>
							))}
					</>
				)}
			</div>
			{!connected && <span className="offline">Offline</span>}
			<Slot name="artifact-actions" />
			<Slot name="terminal-actions" />
			<Slot name="workspace-actions" />
			<Slot name="session-options" />
			<Slot name="session-actions" />
		</header>
	);
}

/** The viewed conversation's transcript (see `TranscriptStore`), and its store. */
function useTranscriptPages(key: string, chat: Held<typeof Chat> | undefined) {
	const host = useHost();
	const store = chat
		? transcriptOf(host, key, { view: chat.view, entries: (query) => chat.entries(query, BACKGROUND_CONTEXT) })
		: undefined;
	const subscribe = useCallback((onChange: () => void) => store?.subscribe(onChange) ?? (() => {}), [store]);
	const read = useCallback(() => store?.value, [store]);
	return [useSyncExternalStore(subscribe, read, read), store] as const;
}

/**
 * What this device kept of conversation `key` (conversation-cache.ts), once loaded; only for the owner. Its measured row
 * heights seed the transcript's, so the kept transcript opens where it was laid out.
 */
function useKept(key: string, owner: boolean): Kept | undefined {
	const [kept, setKept] = useState<{ key: string; value: Kept | undefined }>();
	useEffect(() => {
		if (!owner) return;
		let current = true;
		void loadKept(key).then((value) => {
			if (!current) return;
			if (value) seedSizes(key, value.sizes);
			setKept({ key, value });
		});
		return () => {
			current = false;
		};
	}, [key, owner]);
	return kept?.key === key ? kept.value : undefined;
}

/** Joins restored texts and the current draft into one draft, skipping empty parts. */
const joinDraft = (...parts: readonly string[]): string => parts.filter((part) => part.trim()).join("\n\n");

/**
 * Inputs of this author withdrawn by someone else (Stop, a queue edit) come back into the composer. Each is
 * claimed once, so only one of the author's tabs gets it.
 */
function useRestoredDrafts(
	sessionId: string,
	conversationId: number,
	participant: boolean,
	restore: (texts: readonly string[]) => void,
): void {
	const drafts = useObject(Drafts, participant ? { session: sessionId, conversation: conversationId } : undefined);
	const pending = useReadable(drafts?.drafts);
	useEffect(() => {
		if (!drafts || !pending?.length) return;
		drafts
			.claim({ ids: pending.map((item) => item.id) }, BACKGROUND_CONTEXT)
			.then(({ texts }) => restore(texts))
			.catch(() => {});
	}, [drafts, pending, restore]);
}

function SessionChat({ sessionId, conversationId }: { sessionId: string; conversationId: number }) {
	const nav = useNavigation();
	const openConversation = useCallback(
		(conversation: number) => {
			void nav.push(conversationRoute(nav.route, sessionId, conversation));
		},
		[nav, sessionId],
	);
	const openWorkspaceFile = useCallback(
		(path: string, line?: number) => {
			const current = nav.route;
			void nav.push({
				...current,
				workspace: {
					...(current.workspace ?? { tab: "files", directory: "" }),
					file: { path, view: "file", line },
				},
			});
		},
		[nav],
	);
	// The terminal panel where it is open (the workspace's tab), else below the chat.
	const openTerminal = useCallback(
		(terminalId: string) => {
			const current = nav.route;
			void nav.push(
				current.workspace?.tab === "terminal"
					? { ...current, workspace: { ...current.workspace, terminal: terminalId, startTerminal: undefined } }
					: { ...current, terminal: terminalId, startTerminal: undefined },
			);
		},
		[nav],
	);
	const connected = useConnected();
	const host = useHost();
	// The catalog as the owner or a guest sees it (`worker` is a session worker's).
	const sessions = liveIn(useObject(Sessions, {}), "owner", "guest");
	const listed = useReadable(sessions?.sessions);
	const session = listed?.find((entry) => entry.id === sessionId);
	// A session archived or removed elsewhere while viewed: the new-session screen replaces it, and the toast says why
	// (Pi Mobile's attach errors). Archiving from this view navigates first, so it never shows here.
	const { setError: toast } = useComposerState();
	useEffect(() => {
		const current = nav.route;
		if (listed && (!session || session.archivedAt !== null) && current.session === sessionId) {
			// What this device kept of a session the server no longer has goes with it (an archived one stays).
			if (!session) void forgetSession(sessionId);
			toast(session ? "Session is archived" : "Session not found");
			void nav.replace(conversationRoute(current, undefined), current);
		}
	}, [listed, session, nav, sessionId, toast]);
	// Who this browser is, as the server last said: kept while reconnecting (`useOwner`), so the composer stays.
	const access = useObject(Access, {});
	const liveGrant = useReadable(liveIn(access, "guest")?.grant);
	const owner = useOwner();
	const lastGrant = useRef(liveGrant);
	// Taken while the object is live, a removed grant (null) included.
	if (useStatus(access) === "live") lastGrant.current = liveGrant;
	const grant = owner ? undefined : lastGrant.current;
	const models = useObject(Models, owner ? {} : undefined);
	const resources = useReadable(models?.resources);
	const subagents = liveIn(useObject(Subagents, {}), "reader");
	const children = useReadable(subagents?.children);
	const child = children?.[sessionId]?.find((entry) => entry.conversationId === conversationId);
	// A code mode script's one-shot agent: read-only, opened from the script's tool card.
	const oneShot = child?.kind === "agent";
	// Where the viewed conversation works: a subagent may have its own location (e.g. a git worktree, or another machine).
	const viewLocation = conversationLocation(session, child);
	const viewCwd = viewLocation?.cwd;
	const oneShots = useMemo(
		() =>
			new Map(
				(children?.[sessionId] ?? []).flatMap((agent) =>
					agent.kind === "agent" && agent.callId ? [[agent.callId, agent.conversationId] as const] : [],
				),
			),
		[children, sessionId],
	);
	// Only subagents and the main conversation are shown: an earlier `/tree` branch (another device switched, or a link
	// from before) and unknown conversations open the main one.
	const main = session?.main;
	useEffect(() => {
		const current = nav.route;
		if (
			children &&
			main !== undefined &&
			conversationId !== main &&
			!child &&
			current.session === sessionId &&
			current.conversation === conversationId
		)
			void nav.replace(conversationRoute(current, sessionId, main), current);
	}, [children, child, conversationId, main, nav, sessionId]);
	const workers = liveIn(useObject(SessionStatus, {}), "reader");
	const workerError = useReadable(workers?.statuses)?.[sessionId]?.error;
	const [activationError, setActivationError] = useState<string>();
	const failure = workerError ?? activationError;
	// A rejected reference is released rather than repeatedly asking a broken worker to start. Chat lingers
	// (`CLIENT_LINGER`): switching to a subagent and back finds this conversation still held, its pages still loaded.
	const chat = useObject(Chat, failure ? undefined : { session: sessionId, conversation: conversationId });
	useEffect(() => {
		let current = true;
		void (chat ? whenLive(chat) : Promise.resolve()).catch((reason: unknown) => {
			if (current) setActivationError(errorText(reason));
		});
		return () => {
			current = false;
		};
	}, [chat]);
	const control = useObject(WorkerControl, owner ? { session: sessionId } : undefined);
	const [retrying, setRetrying] = useState(false);
	const retry = async (): Promise<void> => {
		if (!control || retrying) return;
		setRetrying(true);
		try {
			await control.restart(BACKGROUND_CONTEXT);
			setActivationError(undefined);
		} catch (reason) {
			setActivationError(errorText(reason));
		} finally {
			setRetrying(false);
		}
	};
	const status = useStatus(chat);
	const liveView = useReadable(chat?.view);
	// The conversation as kept on this device (the owner's; conversation-cache.ts): shown until the live view arrives.
	const cacheKey = `${sessionId}#${conversationId}`;
	const kept = useKept(cacheKey, owner);
	// Sessions the server no longer has (deleted elsewhere) are not kept on this device either.
	useEffect(() => {
		if (owner && listed) void keepSessions(new Set(listed.map((entry) => entry.id)));
	}, [owner, listed]);
	// The window as the server or this device has it (its newest entries); the transcript holds more (`pages`).
	const view = liveView ?? kept?.view;
	const participant = status === "live" && chat?.variant === "participant";
	// The members only a participant has (send, stop, queue edits, configure).
	const writer = liveIn(chat, "participant");
	// Who may write decides what shows (as Pi Mobile's `canWrite`), not whether the chat object is live yet: during a
	// load, a cold start or a reconnect the composer stays and only Send waits.
	const canWrite = owner || grantMode(grant, sessionId) === "full";
	const subagentControl = useObject(
		SubagentControl,
		canWrite && child && !oneShot ? { session: sessionId } : undefined,
	);
	const composer = useComposerState();
	const {
		draft,
		setDraft,
		steer,
		setSteer,
		error,
		setError,
		files,
		setFiles,
		viewer,
		stopped,
		setStopped,
		replyTo,
		setReplyTo,
		canReply,
		mentionName,
	} = composer;
	// `/tree` from a message (docs/tree.md): the owner, in the main conversation. A reference of its own, as the switch
	// reaches the session row (whose `main` moves this view) before its result; a user message's text fills the composer.
	const branchFrom = useCallback(
		(entry: number) => {
			const held = host.hold(SessionTree, { session: sessionId }, BACKGROUND_CONTEXT);
			whenLive(held)
				.then(() => {
					const tree = liveIn(held, "owner");
					if (!tree) throw new Error("Only the owner branches the session");
					return tree.navigate({ entry }, BACKGROUND_CONTEXT);
				})
				.then(({ conversation, text }) => {
					if (text !== null) setDraft(text);
					void nav.replace(conversationRoute(nav.route, sessionId, conversation));
				})
				.catch((reason: unknown) => setError(errorText(reason)))
				.finally(() => held.release());
		},
		[host, nav, sessionId, setDraft, setError],
	);
	const canBranch = owner && conversationId === session?.main;
	// Replies exist while a plugin allows them here (chat-mode, in chat mode); the reply action fills the composer.
	const startReply = useCallback(
		(target: { entryId: number; name: string }) => {
			setReplyTo(target);
			document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
		},
		[setReplyTo],
	);
	// Kept while reconnecting, as the composer is (`canWrite`).
	const replying = canWrite && canReply ? replyTo : undefined;
	// `@`/Tab file completion for participants; in chat mode (`canReply`) the agent's mention (`@pi`) is offered first.
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const fileCompletion = useFileCompletion(
		composerRef,
		setDraft,
		participant ? { session: sessionId, conversation: conversationId } : undefined,
		{ mention: canReply ? mentionName : undefined },
	);
	const metrics = useObject(SessionMetrics, { session: sessionId, viewer });
	const clients = useReadable(metrics?.clients) ?? 0;
	const usage = useReadable(metrics?.usage) ?? undefined;
	const cwdSheet = useSheet("cwd");
	const modelSheet = useSheet("model");
	const costSheet = useSheet("cost");
	/**
	 * Restored text goes into the composer, which takes the focus, as in Pi Mobile; sending it again is a new message
	 * (each send has its own request ID). Stop and others' withdrawals put it before the draft, a queue edit after.
	 */
	const restore = useCallback(
		(texts: readonly string[], after = false) => {
			if (!texts.length) return;
			setDraft((current) => (after ? joinDraft(current, ...texts) : joinDraft(...texts, current)));
			document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
		},
		[setDraft],
	);
	useRestoredDrafts(sessionId, conversationId, participant, restore);
	const [pages, transcriptStore] = useTranscriptPages(cacheKey, chat);
	// What this device kept starts the transcript; the live view is merged into it when it continues it.
	useEffect(() => {
		if (kept && transcriptStore) transcriptStore.seed(kept.view);
	}, [kept, transcriptStore]);
	// The live state is kept for the next start (a second after it settles, or when the page is hidden); older pages
	// arriving are a change too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `pages` changes when pages arrive; read at write time.
	useEffect(() => {
		const store = transcriptStore;
		if (!owner || !liveView || !store?.value) return;
		keep(cacheKey, () => ({ view: store.value!.view, sizes: [...keptSizes(cacheKey)] }));
	}, [owner, liveView, pages, transcriptStore, cacheKey]);
	const perform = useCallback(
		(action: Promise<unknown> | undefined) => {
			void action?.catch((reason: unknown) => setError(errorText(reason)));
		},
		[setError],
	);
	// Plugins show their own display-only entry kinds (chat-mode's chat messages) as people's messages.
	const entryKinds = useRegistry(TranscriptEntries);
	const display = useCallback((kind: string, data: unknown) => entryKinds.get(kind)?.(data), [entryKinds]);
	const transcript = useMemo(
		() => (pages ? buildTranscript(pages.view, display, pages.filling) : undefined),
		[pages, display],
	);
	const stats = useReadable(chat?.stats) ?? undefined;
	// Messages sent from here that the server does not show yet (outbox.ts): shown as they will look, a person's
	// message at the end, or a queued input while a run is busy. An accepted one is shown by the server once its queued
	// input is listed or the view has an entry newer than any before it was sent.
	const outbox = outboxOf(`${sessionId}#${conversationId}`);
	const outgoing = useSyncExternalStore(outbox.subscribe, outbox.snapshot);
	const newestEntry = view?.entries.at(-1)?.id ?? 0;
	const newest = useRef(newestEntry);
	newest.current = newestEntry;
	const queuedIds = useMemo(() => new Set(transcript?.queued.map((item) => item.id)), [transcript]);
	const shownByServer = useCallback(
		(message: Outgoing) =>
			message.sent !== undefined && (queuedIds.has(message.sent.submissionId) || newestEntry > message.sent.after),
		[queuedIds, newestEntry],
	);
	useEffect(() => outbox.settle(shownByServer), [outbox, shownByServer]);
	const pending = useMemo(() => outgoing.filter((message) => !shownByServer(message)), [outgoing, shownByServer]);
	const busy = transcript?.busy ?? false;
	const shown = useMemo(
		() =>
			transcript && pending.length > 0 && !busy
				? { ...transcript, items: [...transcript.items, ...pending.map((message) => message.item)] }
				: transcript,
		[transcript, pending, busy],
	);
	const pendingQueued = busy ? pending : [];
	const rows = useMemo(() => (shown ? transcriptRows(shown.items) : undefined), [shown]);
	const follow = useChatScroll({
		cache: `${sessionId}#${conversationId}`,
		...(rows ? { rows } : {}),
		estimates: rowEstimates,
		...(transcript && pages ? { history: { more: transcript.earlier, loading: pages.loadingEarlier } } : {}),
		onEarlier: () => void loadEarlier(),
	});
	const attaching = attachingOf(composer);
	// The author the server will record, as the transcript last showed it: the outgoing message looks the same.
	const author = useMemo(() => {
		const own = transcript?.items.findLast(
			(item) =>
				item.type === "user" &&
				item.author !== undefined &&
				(owner ? item.author.kind === "owner" : item.author.kind === "guest" && item.author.name === grant?.name),
		);
		return own?.type === "user" ? own.author : undefined;
	}, [transcript, owner, grant]);
	/**
	 * Sends the composer's message without waiting for the connection: it leaves the composer and shows at once, and
	 * the outbox delivers it when it can (outbox.ts). Sending keeps the reader's scroll position; the scroll-down button
	 * follows the answer when wanted.
	 */
	const send = () => {
		const text = draft.trim();
		if ((!text && !files.length) || !canWrite) return;
		setStopped(undefined);
		const id = crypto.randomUUID();
		outbox.add({
			id,
			text,
			files: [...files],
			whenBusy: steer ? "steer" : "followUp",
			...(replying ? { replyTo: replying } : {}),
			item: {
				type: "user",
				key: `outgoing-${id}`,
				text,
				images: [],
				files: files.map((file) => file.file.name),
				...(author ? { author } : owner ? { author: { kind: "owner", id: "owner", name: "Owner" } } : {}),
			},
		});
		setDraft("");
		setFiles([]);
		setReplyTo(undefined);
		setSteer(true);
	};
	// The outbox sends while this conversation's chat object is live; the latest values, for its sender.
	const latest = useRef({ chat: writer, host, sessionId, conversationId });
	latest.current = { chat: writer, host, sessionId, conversationId };
	const live = connected && status === "live" && writer !== undefined;
	useEffect(() => {
		if (!live) {
			outbox.connect(undefined);
			return;
		}
		outbox.connect({
			send: async (message) => {
				const { chat: current, host: client, sessionId: session, conversationId: conversation } = latest.current;
				if (!current) throw new Error("not connected");
				const after = newest.current;
				const attachments: string[] = [];
				for (const file of message.files) {
					if (file.session !== session) {
						file.uploaded = undefined;
						file.session = session;
					}
					file.uploaded ??= await upload(session, file.file);
					attachments.push(file.uploaded);
				}
				// `/template args` and `/skill:name args` expand on the session worker first (10.8).
				const text = message.text.startsWith("/")
					? await expandComposerText(client, session, conversation, message.text)
					: message.text;
				const { submissionId } = await current.send(
					{
						text,
						requestId: message.id,
						whenBusy: message.whenBusy,
						...(attachments.length ? { attachments } : {}),
						...(message.replyTo ? { replyTo: message.replyTo.entryId } : {}),
					},
					BACKGROUND_CONTEXT,
				);
				return { submissionId, after };
			},
			refused,
			restore: (message, error) => {
				restore([message.text]);
				setFiles((current) => [...message.files, ...current]);
				if (message.replyTo) setReplyTo((current) => current ?? message.replyTo);
				setError(errorText(error));
			},
		});
		return () => outbox.connect(undefined);
	}, [live, outbox, restore, setFiles, setReplyTo, setError]);
	// Leaving the page loses what the outbox has not delivered: the browser asks first.
	useEffect(() => {
		if (outgoing.every((message) => message.sent)) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [outgoing]);
	const stop = () => {
		// What the outbox has not sent comes back to the composer, as the server's queued inputs do.
		const unsent = outbox.takeUnsent();
		if (unsent.length) {
			restore(unsent.map((message) => message.text));
			setFiles((current) => [...unsent.flatMap((message) => message.files), ...current]);
		}
		if (!writer) return;
		perform(
			writer.stop(BACKGROUND_CONTEXT).then(({ restored }) => {
				restore(restored);
				setStopped({ sessionId, conversationId });
			}),
		);
	};
	/** Pages earlier entries into the transcript (Pi Mobile's `loadOlder`). */
	const loadEarlier = async () => {
		try {
			await transcriptStore?.loadEarlier();
		} catch (reason) {
			setError(errorText(reason));
		}
	};
	/** Loads the missing entries of a gap, a page at a time. */
	const fillGap = useCallback(
		(gap: Gap) => {
			transcriptStore?.fillGap(gap).catch((reason: unknown) => setError(errorText(reason)));
		},
		[transcriptStore, setError],
	);
	/** Loads entries until `entryId` is shown (a quoted message, a search hit); false when it is not here. */
	const reveal = useCallback(
		async (entryId: number): Promise<boolean> => {
			if (!transcriptStore) return false;
			try {
				return await transcriptStore.loadThrough(entryId);
			} catch (reason) {
				setError(errorText(reason));
				return false;
			}
		},
		[transcriptStore, setError],
	);
	// A search hit opened this conversation at one of its messages.
	const revealRequests = useSyncExternalStore(revealRequest.subscribe, revealRequest.count);
	const loaded = pages !== undefined;
	useEffect(() => {
		const entryId = revealRequests >= 0 ? takeReveal(sessionId, conversationId, loaded) : undefined;
		if (entryId !== undefined) void revealEntry(entryId, reveal);
	}, [sessionId, conversationId, loaded, reveal, revealRequests]);
	const agentModel = transcript?.agent.model;
	const contextWindow = resources?.models.find(
		(entry) => entry.provider === agentModel?.provider && entry.modelId === agentModel?.modelId,
	)?.contextWindow;
	// Once earlier pages were loaded, the transcript's top edge marks the conversation's start.
	const first = pages?.view.items.find((item) => item.kind === "entry");
	const paged = (first?.kind === "entry" ? first.entry.id : Number.POSITIVE_INFINITY) < (view?.entries[0]?.id ?? 0);
	const earlier = transcript?.earlier ? (pages?.loadingEarlier ? "loading" : "more") : paged ? "start" : undefined;
	const choice: ModelChoice | undefined = session
		? {
				model: agentModel ?? session.model,
				thinkingLevel: transcript?.agent.thinkingLevel ?? (session.thinkingLevel as ModelChoice["thinkingLevel"]),
			}
		: undefined;
	const modelControl = owner ? (
		<ModelControl resources={resources} {...(choice ? { choice } : {})} />
	) : (
		<span className="model-control static">{grant?.name} · guest</span>
	);
	const footer = (
		<SessionStats
			usage={usage}
			cacheUsage={stats?.latestAssistantUsage}
			clients={clients}
			context={
				stats && contextWindow && contextWindow > 0
					? { used: stats.contextTokens, limit: contextWindow }
					: // The owner gets the bar once the model's context window is known: its space stays meanwhile.
						owner
						? "pending"
						: undefined
			}
			onCost={() => openLayer({ kind: "sheet", name: "cost" })}
			onClients={owner ? () => openLayer({ kind: "sheet", name: "share" }) : undefined}
			controls={modelControl}
		/>
	);
	return (
		<>
			<TopBar session={session} child={child} owner={owner} />
			{cwdSheet && owner && session && (
				<DirectoryPicker
					value={session.cwd}
					env={session.env ?? null}
					moving={{ env: session.env ?? null }}
					recent={(env) => [
						...new Set((listed ?? []).filter((row) => (row.env ?? null) === env).map((row) => row.cwd)),
					]}
					onClose={closeLayers}
					onChange={(env, cwd) => {
						perform(liveIn(sessions, "owner")?.relocate({ id: sessionId, env, cwd }, BACKGROUND_CONTEXT));
						closeLayers();
					}}
				/>
			)}
			{modelSheet && owner && (
				<ModelPicker
					resources={resources}
					value={choice}
					onChange={(choice) => perform(writer?.configure(choice, BACKGROUND_CONTEXT))}
					onDefault={(choice) =>
						perform(
							models?.setDefault({ ...choice.model, thinkingLevel: choice.thinkingLevel }, BACKGROUND_CONTEXT),
						)
					}
					onClose={closeLayers}
				/>
			)}
			{costSheet && (
				<CostPanel
					load={async () => {
						const costs = host.hold(
							ChatCosts,
							{ session: sessionId, conversation: conversationId },
							BACKGROUND_CONTEXT,
						);
						try {
							return await costs.costs(BACKGROUND_CONTEXT);
						} finally {
							costs.release();
						}
					}}
					onClose={closeLayers}
				/>
			)}

			<ErrorToast error={error} onDismiss={() => setError(undefined)} />
			<div className="chat">
				<div className="scroller transcript" ref={follow.scroller}>
					{failure && connected ? (
						<div className="hero worker-start-error">
							<h2>Session unavailable</h2>
							<p className="error" role="alert">
								{failure}
							</p>
							{owner ? (
								<div className="actions">
									<button type="button" className="button" disabled={retrying} onClick={() => void retry()}>
										Retry
									</button>
									<button
										type="button"
										className="button"
										onClick={() =>
											openLayer({ kind: "sheet", name: "logs", locator: `session:${sessionId}` })
										}
									>
										Show logs
									</button>
								</div>
							) : (
								<p className="muted">Ask the owner to retry this session.</p>
							)}
						</div>
					) : transcript ? (
						shown?.items.length && rows ? (
							<SessionId.Provider value={sessionId}>
								<WorkingDirectory.Provider value={viewCwd}>
									<OpenConversation.Provider value={openConversation}>
										<OneShotAgents.Provider value={oneShots}>
											<OpenWorkspaceFile.Provider value={canWrite ? openWorkspaceFile : undefined}>
												<OpenTerminal.Provider value={owner ? openTerminal : undefined}>
													<ReplyTo.Provider value={participant && canReply ? startReply : undefined}>
														<BranchFrom.Provider value={canBranch ? branchFrom : undefined}>
															<RevealEntry.Provider value={reveal}>
																<FillGap.Provider value={fillGap}>
																	<Messages
																		transcript={shown ?? transcript}
																		rows={rows}
																		list={follow.list}
																		range={follow.range}
																		stopped={
																			stopped?.sessionId === sessionId &&
																			stopped?.conversationId === conversationId &&
																			!view?.entries.some((entry) =>
																				entry.model?.some(
																					(message) =>
																						message.role === "assistant" &&
																						message.stopReason === "aborted",
																				),
																			)
																		}
																		earlier={earlier}
																		onEarlier={() => void loadEarlier()}
																	/>
																</FillGap.Provider>
															</RevealEntry.Provider>
														</BranchFrom.Provider>
													</ReplyTo.Provider>
												</OpenTerminal.Provider>
											</OpenWorkspaceFile.Provider>
										</OneShotAgents.Provider>
									</OpenConversation.Provider>
								</WorkingDirectory.Provider>
							</SessionId.Provider>
						) : (
							<div className="hero small-hero">
								<p className="muted">Send a message to start.</p>
							</div>
						)
					) : (
						<div className="hero">
							<div className="spinner large" />
						</div>
					)}
				</div>
				<div className="dock" ref={follow.dock}>
					{child && (
						<div className="composer-wrap subagent-wrap">
							{/* A one-shot view has no composer, which otherwise carries this button. */}
							{oneShot && !follow.atBottom && (
								<button
									type="button"
									className="to-bottom"
									onClick={follow.toBottom}
									aria-label="Scroll to bottom"
								>
									<DownIcon />
								</button>
							)}
							<div className="subagent-bar">
								<span>
									{oneShot ? "One-shot agent of a script · read-only · " : ""}
									Tools: {child.tools.join(", ") || "none"}
									{!oneShot && viewLocation && ` · in ${locationLabel(viewLocation.env, viewLocation.cwd)}`}
									{!oneShot && !child.location && " · follows the session"}
									{child.archived ? " · archived" : ""}
								</span>
								{canWrite && !oneShot && (
									<button
										type="button"
										className="text-action"
										title={
											child.archived
												? "Show it in the sidebar again"
												: "Stop it and move it to the sidebar's archived row"
										}
										onClick={() =>
											perform(
												subagentControl?.archive(
													{
														conversation: child.conversationId,
														archived: !child.archived,
													},
													BACKGROUND_CONTEXT,
												),
											)
										}
									>
										{child.archived ? "Restore" : "Archive"}
									</button>
								)}
								{canWrite && oneShot && busy && (
									<button type="button" className="round stop" aria-label="Stop" onClick={stop}>
										<StopIcon />
									</button>
								)}
							</div>
						</div>
					)}
					{oneShot && canWrite ? null : (
						<div className="composer-wrap">
							{/* Only with the composer, as in Pi Mobile: the read-only bar has no scroll button. */}
							{canWrite && !failure && !follow.atBottom && (
								<button
									type="button"
									className="to-bottom"
									onClick={follow.toBottom}
									aria-label="Scroll to bottom"
								>
									<DownIcon />
								</button>
							)}
							{!canWrite || failure ? (
								<div className="subagent-bar">
									<span>
										{failure
											? "Session unavailable"
											: grant
												? `Joined as ${grant.name} · read-only`
												: "Connecting…"}
									</span>
								</div>
							) : (
								<>
									{transcript && transcript.queued.length + pendingQueued.length > 0 && (
										<div className="queued">
											{pendingQueued.map((message) => (
												<div key={`outgoing-${message.id}`}>
													<button
														type="button"
														className="queue-edit"
														title="Move back to editor"
														onClick={() => {
															if (!outbox.take(message.id)) return;
															restore([message.text], true);
															setFiles((current) => [...current, ...message.files]);
														}}
													>
														<span>{message.whenBusy === "steer" ? "Steer" : "Queued"}</span>{" "}
														{message.text}
													</button>
													<button
														type="button"
														className="queue-remove"
														aria-label="Remove from queue"
														onClick={() => outbox.remove(message.id)}
													>
														<CloseIcon />
													</button>
												</div>
											))}
											{transcript.queued.map((item) => (
												<div key={item.id}>
													<button
														type="button"
														className="queue-edit"
														title="Move back to editor"
														onClick={() =>
															perform(
																writer
																	?.dequeue(
																		{ submissionId: item.id, restore: true },
																		BACKGROUND_CONTEXT,
																	)
																	.then(({ text }) => {
																		if (text) restore([text], true);
																	}),
															)
														}
													>
														<span>{item.mode === "steer" ? "Steer" : "Queued"}</span> {item.text}
													</button>
													<button
														type="button"
														className="queue-remove"
														aria-label="Remove from queue"
														onClick={() =>
															perform(writer?.dequeue({ submissionId: item.id }, BACKGROUND_CONTEXT))
														}
													>
														<CloseIcon />
													</button>
												</div>
											))}
										</div>
									)}
									<Composer
										draft={draft}
										setDraft={setDraft}
										busy={busy}
										steer={steer}
										setSteer={setSteer}
										disabled={false}
										onSend={send}
										onStop={stop}
										attaching={attaching}
										completion={fileCompletion}
										textareaRef={composerRef}
										replying={replying && { name: replying.name, onCancel: () => setReplyTo(undefined) }}
									>
										<SlotList prefix="composer" />
									</Composer>
									{footer}
								</>
							)}
						</div>
					)}
				</div>
			</div>
			<Slot name="chat-bottom" />
		</>
	);
}

function NewSession() {
	const follow = useChatScroll();
	const connected = useConnected();
	const host = useHost();
	const owner = useOwner();
	const catalog = useObject(Sessions, {});
	const listed = useReadable(liveIn(catalog, "owner", "guest")?.sessions);
	// Only the owner creates sessions.
	const sessions = liveIn(catalog, "owner");
	const models = useObject(Models, owner ? {} : undefined);
	const resources = useReadable(models?.resources);
	const recent = useMemo(() => (listed ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt), [listed]);
	const { location: selectedLocation, setLocation, choice: selectedChoice, setChoice } = useNewSessionState();
	const location =
		selectedLocation ?? (recent[0] ? { env: recent[0].env ?? null, cwd: recent[0].cwd } : { env: null, cwd: "~" });
	const fallback = resources?.settings.defaultModel ?? recent[0]?.model;
	const choice: ModelChoice | undefined =
		selectedChoice ??
		(fallback ? { model: fallback, thinkingLevel: resources?.settings.thinkingLevel ?? "high" } : undefined);
	const composer = useComposerState();
	const {
		draft,
		setDraft,
		files,
		setFiles,
		error,
		setError,
		sending,
		setSending,
		submission,
		steer,
		setSteer,
		setStopped,
	} = composer;
	const cwdSheet = useSheet("cwd");
	const modelSheet = useSheet("model");
	const attaching = attachingOf(composer);
	const send = async () => {
		const text = draft.trim();
		if ((!text && !files.length) || !sessions || sending || !connected || !owner) return;
		if (!choice) {
			openLayer({ kind: "sheet", name: "model" });
			return;
		}
		setStopped(undefined);
		const key = `new:1:${text}\u0000${files.map((file) => file.key).join()}`;
		if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
		setSending(true);
		try {
			const session = await sessions?.create(
				{
					env: location.env,
					cwd: location.cwd,
					model: choice.model,
					thinkingLevel: choice.thinkingLevel,
				},
				BACKGROUND_CONTEXT,
			);
			const chat = host.hold(Chat, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
			try {
				navigate({ session: session.id }, { replace: true });
				await whenLive(chat);
				const attachments: string[] = [];
				for (const file of files) {
					// Upload IDs are session-scoped: a new creation must not reuse an earlier failed creation's IDs.
					file.session = session.id;
					file.uploaded = await upload(session.id, file.file);
					attachments.push(file.uploaded);
				}
				await liveIn(chat, "participant")!.send(
					{
						text,
						requestId: submission.current.id,
						...(attachments.length ? { attachments } : {}),
					},
					BACKGROUND_CONTEXT,
				);
				setDraft("");
				setFiles([]);
				setSteer(true);
				submission.current = undefined;
			} finally {
				chat.release();
			}
		} catch (error) {
			setError(errorText(error));
		} finally {
			setSending(false);
		}
	};
	return (
		<>
			<TopBar />
			{cwdSheet && (
				<DirectoryPicker
					value={location.cwd}
					env={location.env}
					recent={(env) => [
						...new Set(recent.filter((session) => (session.env ?? null) === env).map((session) => session.cwd)),
					]}
					onChange={(env, cwd) => {
						setLocation({ env, cwd });
						closeLayers();
					}}
					onClose={closeLayers}
				/>
			)}
			{modelSheet && owner && (
				<ModelPicker
					resources={resources}
					value={choice}
					onChange={setChoice}
					onDefault={(choice) =>
						void models
							?.setDefault({ ...choice.model, thinkingLevel: choice.thinkingLevel }, BACKGROUND_CONTEXT)
							.catch((error) => setError(errorText(error)))
					}
					onClose={closeLayers}
				/>
			)}
			<ErrorToast error={error} onDismiss={() => setError(undefined)} />
			<div className="chat">
				<div className="scroller" ref={follow.scroller}>
					<div className="hero">
						<div className="hero-title">
							<PiLogo />
							<h2>What should Pi do?</h2>
						</div>
						<button
							type="button"
							className="cwd-pick"
							onClick={() => openLayer(directoryPickerLayer(location.env, location.cwd))}
						>
							<FolderIcon />
							<span>{locationLabel(location.env, location.cwd)}</span>
							<ChevronIcon size={14} />
						</button>
						{owner && resources && !resources.credentials.length && (
							<button
								type="button"
								className="button"
								onClick={() => openLayer({ kind: "sheet", name: "providers" })}
							>
								Sign in to a provider
							</button>
						)}
					</div>
				</div>
				<div className="dock" ref={follow.dock}>
					<div className="composer-wrap">
						{owner ? (
							<>
								<Composer
									draft={draft}
									setDraft={setDraft}
									busy={false}
									steer={steer}
									setSteer={setSteer}
									disabled={!connected || sending}
									onSend={() => void send()}
									attaching={attaching}
								/>
								<div className="session-usage">
									<div className="session-controls">
										<ModelControl resources={resources} {...(choice ? { choice } : {})} />
									</div>
								</div>
							</>
						) : (
							<div className="subagent-bar">
								<span>Connecting…</span>
							</div>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

/** A guest's share ended: Pi Mobile clears the view and says so in its toast; nothing reconnects. */
function ShareEnded() {
	return (
		<>
			<TopBar />
			<button type="button" className="toast">
				This share has ended.
			</button>
			<div className="chat">
				<div className="scroller" />
			</div>
		</>
	);
}

function Main() {
	const nav = useNavigation();
	const route = useRoute();
	const ended = useShareEnded();
	const access = useObject(Access, {});
	const grant = useReadable(liveIn(access, "guest")?.grant);
	// A guest stays within the sessions shared with it; anywhere else it lands in the one shared or joined last.
	useEffect(() => {
		if (grant && !grantMode(grant, route.session)) void nav.replace(conversationRoute(route, grant.session), route);
	}, [grant, route, nav]);
	if (ended) return <ShareEnded />;
	return route.session ? (
		<Slot name="chat-content">
			<Slot name="chat-attribution">
				<SessionChat
					key={`${route.session}:${route.conversation ?? 1}`}
					sessionId={route.session}
					conversationId={route.conversation ?? 1}
				/>
			</Slot>
		</Slot>
	) : (
		<NewSession />
	);
}

export default defineFacet((host, self) => {
	// The chat plugin defines the transcript's entry displays (chat-mode adds its own): served on the page too.
	serveKeyed(host, TranscriptEntries);
	self.contribute(Slots, { main: Main });
});
