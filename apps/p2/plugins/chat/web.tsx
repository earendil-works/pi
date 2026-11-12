// Main view: the transcript of the open session with its composer, or the new-session screen; the model commands of
// the command menu (commands.tsx).

import {
	Access,
	BACKGROUND_CONTEXT,
	defineFacet,
	expandComposerText,
	grantMode,
	type Held,
	isChordError,
	keptIn,
	liveIn,
	serveKeyed,
	UI_LINGER,
	whenLive,
} from "@p2/app/v1";
import {
	AttachIcon,
	BranchFrom,
	buildTranscript,
	ChevronIcon,
	CloseIcon,
	CommandPages,
	Commands,
	type CommandTarget,
	ContextUsage,
	CostPanel,
	closeLayers,
	conversationKey,
	conversationRoute,
	type Detail,
	DownIcon,
	ErrorToast,
	errorText,
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
	knownMain,
	LockIcon,
	lightTap,
	loadKept,
	locationLabel,
	MenuIcon,
	Messages,
	type ModelChoice,
	ModelPicker,
	modelName,
	NEW_SESSION,
	navigate,
	OneShotAgents,
	OpenConversation,
	OpenTerminal,
	OpenWorkspaceFile,
	openLayer,
	openSidebar,
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
	ToolActivities,
	ToolActivityContext,
	type Transcript,
	takeReveal,
	transcriptOf,
	transcriptRows,
	useChatScroll,
	useCommandRouteTarget,
	useComposerState,
	useConnected,
	useFileCompletion,
	useHost,
	useNavigation,
	useNewSessionState,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRegistry,
	useRoute,
	useShareEnded,
	useSheet,
	useStatus,
	WorkingDirectory,
} from "@p2/app/v1/web";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Drafts } from "../drafts/contract.ts";
import { Envs } from "../envs/contract.ts";
import { DirectoryPicker, directoryPickerLayer } from "../envs/contract.web.tsx";
import { GlyphIcon } from "../glyphs/GlyphIcon.tsx";
import { Models } from "../models/contract.ts";
import type { ResourceSnapshot } from "../models/resources.ts";
import { Projects } from "../projects/contract.ts";
import { placeSeed } from "../projects/glyph-seed.ts";
import { type Session, Sessions } from "../sessions/contract.ts";
import { SessionMetrics, SessionStatus, WorkerControl } from "../status/contract.ts";
import { type Child, conversationLocation, SubagentControl, Subagents } from "../subagents/contract.ts";
import { openMain } from "../subagents/contract.web.ts";
import { SessionTree } from "../tree/contract.ts";
import { MODEL_COMMANDS, MODEL_PAGES } from "./commands.tsx";
import { Chat, ChatCosts, conversationTargetId, TranscriptEntries } from "./contract.ts";
import { newSessionChoice, thinkingLevelOf } from "./model-choice.ts";
import { type Outgoing, outboxOf } from "./outbox.ts";
import { sessionStart } from "./session-start.ts";

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

/** The owner on an outgoing message before the transcript has shown one of theirs (the default owner name). */
const OWNER_AUTHOR = { kind: "owner", id: "owner", name: "Owner" } as const;

/** A message sent from here as the transcript will show it, until the server shows it (outbox.ts). */
function outgoingItem(
	id: string,
	text: string,
	files: readonly PickedFile[],
	author: Outgoing["item"]["author"],
): Outgoing["item"] {
	return {
		type: "user",
		key: `outgoing-${id}`,
		text,
		images: [],
		files: files.map((file) => file.file.name),
		...(author ? { author } : {}),
	};
}

/** A transcript of only messages sent from here: what shows before the server has the conversation (a new session). */
const outgoingTranscript = (messages: readonly Outgoing[]): Transcript => ({
	items: messages.map((message) => message.item),
	earlier: false,
	busy: false,
	working: false,
	compactions: [],
	queued: [],
	agent: {},
});

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

/**
 * The page-wide objects the conversation screens read, held once by `Main`: a screen is keyed by its conversation, so
 * holding them in it would hold them anew, and receive their whole state again, at every switch.
 */
type PageObjects = {
	readonly sessions: Held<typeof Sessions> | undefined;
	readonly access: Held<typeof Access> | undefined;
	readonly subagents: Held<typeof Subagents> | undefined;
	readonly status: Held<typeof SessionStatus> | undefined;
	/** The owner's only. */
	readonly models: Held<typeof Models> | undefined;
	/** The owner's only. */
	readonly envs: Held<typeof Envs> | undefined;
	/** The owner's only: projects.json and the sessions' projects, for the top bar's project glyph. */
	readonly projects: Held<typeof Projects> | undefined;
};

const PageObjectsContext = createContext<PageObjects | undefined>(undefined);

function usePageObjects(): PageObjects {
	const objects = useContext(PageObjectsContext);
	if (objects === undefined) throw new Error("usePageObjects outside Main");
	return objects;
}

/**
 * The owner's model catalog and settings, with the default model as just chosen: `setDefault` shows the choice as the
 * default at once (the picker's mark) and rolls back if the server refuses it.
 */
function useModelResources(fail: (error: unknown) => void) {
	const { models } = usePageObjects();
	const [resources, guess] = useOptimisticCall(
		useReadable(models?.resources),
		(snapshot, choice: ModelChoice) =>
			snapshot && {
				...snapshot,
				settings: { ...snapshot.settings, defaultModel: choice.model, thinkingLevel: choice.thinkingLevel },
			},
		fail,
	);
	const setDefault = (choice: ModelChoice) => {
		if (models)
			guess(choice, () =>
				models.setDefault({ ...choice.model, thinkingLevel: choice.thinkingLevel }, BACKGROUND_CONTEXT),
			);
	};
	return [resources, setDefault] as const;
}

/** Where this device remembers settings.json's `detail` (the owner's), for the moment before the settings arrive. */
const DETAIL_KEY = "p2-detail";
const detailOf = (value: unknown): Detail | undefined =>
	value === 1 || value === 2 || value === 3 || value === 4 ? value : undefined;

/**
 * settings.json's `detail` (undefined: the default): from the owner's settings once they arrive, and until then (each
 * chat holds them anew, a page loads) as this device last saw it, so a chat opens laid out as it will stay instead of
 * regrouping its turns a moment later.
 */
function useDetail(resources: ResourceSnapshot | undefined): Detail | undefined {
	// null: the settings arrived and name no level (the default).
	const known = resources ? (detailOf(resources.settings.detail) ?? null) : undefined;
	useEffect(() => {
		if (known === undefined) return;
		try {
			localStorage.setItem(DETAIL_KEY, known === null ? "" : String(known));
		} catch {
			// Storage unavailable (private mode): only this page's later chats lose it.
		}
	}, [known]);
	if (known !== undefined) return known ?? undefined;
	try {
		return detailOf(Number(localStorage.getItem(DETAIL_KEY)));
	} catch {
		return undefined;
	}
}

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

/** Textarea with send, stop, steer and attachments; Enter sends with a fine pointer, Escape stops. */
function Composer({
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
	// The draft straight from the app's composer state, not through the screen's dock content: that arrives a layout
	// effect after a keystroke, so the controlled textarea rendered the previous text first, which put the caret at the
	// end on every keystroke and broke a phone keyboard's composition (its first tap on Send only closed the keyboard).
	const { draft, setDraft, registerTextarea } = useComposerState();
	const ownRef = useRef<HTMLTextAreaElement>(null);
	const textarea = textareaRef ?? ownRef;
	// The app's composer state focuses it on request (`focus`): opening a session, a reply, restored text.
	const ref = useCallback(
		(element: HTMLTextAreaElement | null) => {
			textarea.current = element;
			registerTextarea(element);
		},
		[textarea, registerTextarea],
	);
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
			onPointerDown={keepComposerFocus}
			onSubmit={(event) => {
				event.preventDefault();
				// A form in a sheet a composer control opened (chat-mode's name) is a React child: its submit bubbles here.
				if (event.target === event.currentTarget) onSend();
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
				ref={ref}
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

/**
 * Keeps the focus in the composer's textarea when anything in the composer but a text field is pressed: Send and Stop,
 * and the space around them. A press that blurs the textarea closes a phone's keyboard and the page grows back under
 * the finger: a thumb landing a few pixels beside Send (the composer's padding, the bar's gaps) only closed the
 * keyboard, and the second tap sent. The click still fires.
 */
function keepComposerFocus(event: React.PointerEvent<HTMLFormElement>): void {
	// Pointer events target elements, never text nodes.
	const target = event.target as Element;
	// Presses in a sheet a composer control opened (a portal) bubble here in React; they are not in the composer.
	if (!event.currentTarget.contains(target) || target.closest("textarea, input, select, [contenteditable]")) return;
	event.preventDefault();
}

/** The composer's settings from the screen in the frame; the frame owns its textarea (`Frame.composer`). */
type ComposerProps = Omit<Parameters<typeof Composer>[0], "textareaRef">;

/**
 * What the chat's dock shows for the screen in the frame: a bar above (a subagent's), and the composer's place with the
 * scroll-down button, holding either a bar (read-only, unavailable, connecting) or the queued inputs, the composer
 * and its footer. Absent: nothing below the bar above (a one-shot agent's view).
 */
type DockContent = {
	/** The screen's key (`conversationKey`): an open's focus request goes to the composer of its own screen. */
	readonly screen: string;
	readonly above?: ReactNode;
	readonly composer?: { readonly toBottom?: ReactNode } & (
		| { readonly bar: ReactNode }
		| { readonly queued?: ReactNode; readonly props: ComposerProps; readonly footer: ReactNode }
	);
};

/** The dock's content, set by the screen in the frame after each of its renders. */
class DockContents {
	#content: DockContent | undefined;
	readonly #listeners = new Set<() => void>();
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	snapshot = (): DockContent | undefined => this.#content;
	set(content: DockContent | undefined): void {
		this.#content = content;
		for (const listener of [...this.#listeners]) listener();
	}
}

/**
 * The chat's frame (`Main`), kept while screens change (the new-session screen, a conversation, another one): the
 * place of a screen's transcript in `.chat`, the dock floating over the transcript's bottom, what the dock shows, and
 * the composer's textarea. There is one composer: opening the session a new session's first message started keeps it,
 * with its focus (and a phone's keyboard) and what was typed meanwhile.
 */
type Frame = {
	readonly view: HTMLDivElement | null;
	readonly dock: HTMLDivElement | null;
	readonly contents: DockContents;
	readonly composer: React.RefObject<HTMLTextAreaElement | null>;
};
const ChatFrame = createContext<Frame | undefined>(undefined);

/**
 * A screen in the chat's frame: `dock` is what the dock shows while it does, and `room` (its transcript's
 * `useChatScroll().dock`) keeps room for the dock. Returns where the transcript goes.
 */
function useChatScreen(
	dock: DockContent | undefined,
	room?: (dock: HTMLDivElement) => (() => void) | undefined,
): (transcript: ReactNode) => ReactNode {
	const { view, dock: docked, contents } = useFrame();
	// After the transcript's scroller is attached: it is rendered into `view`, a child of this screen.
	useLayoutEffect(() => (view && docked && room ? room(docked) : undefined), [view, docked, room]);
	useLayoutEffect(() => contents.set(dock));
	// The next screen sets its own in the same commit, after this cleanup: the dock never shows nothing in between.
	useLayoutEffect(() => () => contents.set(undefined), [contents]);
	return (transcript) => (view ? createPortal(transcript, view) : null);
}

/** The chat's frame, for a screen in it. */
function useFrame(): Frame {
	const frame = useContext(ChatFrame);
	if (!frame) throw new Error("Missing the chat frame");
	return frame;
}

/** The dock: what the screen in the frame says, around the one composer. */
function Dock({ frame, dockRef }: { frame: Frame; dockRef: (element: HTMLDivElement | null) => void }) {
	const content = useSyncExternalStore(frame.contents.subscribe, frame.contents.snapshot);
	const composer = content?.composer;
	const { screenShown } = useComposerState();
	// After the commit that put the screen's composer, or none, in place: the textarea is the one this screen shows.
	useLayoutEffect(() => screenShown(content?.screen), [content, screenShown]);
	// A list page replaces the chat: no chat screen shows, so opening the one shown before waits for it again.
	useLayoutEffect(() => () => screenShown(undefined), [screenShown]);
	return (
		<div className="dock" ref={dockRef}>
			{content?.above}
			{composer && (
				<div className="composer-wrap">
					{composer.toBottom}
					{"bar" in composer ? (
						composer.bar
					) : (
						<>
							{composer.queued}
							<Composer {...composer.props} textareaRef={frame.composer} />
							{composer.footer}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function TopBar({
	session,
	child,
	owner = false,
	moving = false,
}: {
	session?: Session;
	child?: Child;
	owner?: boolean;
	/** The session is being moved (a relocation job runs). */
	moving?: boolean;
}) {
	const connected = useConnected();
	// Only the owner reads environments (`PageObjects.envs`): guests see the location without the sandbox lock.
	const objects = usePageObjects();
	const envs = useReadable(objects.envs?.envs);
	const sandboxed = envs?.find((env) => env.name === session?.env)?.config.type === "gondolin";
	// The project glyph the sidebar shows for this session (guests read no projects: the path's own glyph).
	const kept = keptIn(objects.projects, "owner");
	const projects = useReadable(kept?.projects);
	const memberships = useReadable(kept?.sessions);
	const glyph = session && (
		<GlyphIcon
			seed={placeSeed(projects ?? [], session.env ?? null, session.cwd, memberships?.[session.id])}
			size={11}
		/>
	);
	const lock = sandboxed && (
		<span className="title-lock">
			<LockIcon size={11} />
		</span>
	);
	return (
		<header className="topbar">
			<button type="button" className="icon-button menu sidebar-open" onClick={openSidebar} aria-label="Sessions">
				<MenuIcon />
				<Slot name="menu-badge" />
			</button>
			<div className="title">
				{child ? (
					<>
						<h1>
							<span className="sub-tag">{child.kind === "agent" ? "agent" : "subagent"}</span> {child.name}
						</h1>
						<button type="button" className="crumb" onClick={() => session && openMain(session.id, session.main)}>
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
									{...(sandboxed ? { title: `Sandbox ${session.env}: tools run in its VM` } : {})}
								>
									{moving ? (
										"Moving…"
									) : (
										<>
											{lock}
											{glyph}
											{locationLabel(session.env, session.cwd)}
										</>
									)}
								</button>
							) : (
								<p>
									{glyph}
									{locationLabel(session.env, session.cwd)}
								</p>
							))}
					</>
				)}
			</div>
			{!connected && <span className="offline">Offline</span>}
			<Slot name="view-actions" />
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

/**
 * What the command menu acts on while a conversation shows: a subagent's conversation, else the session while its own
 * conversation shows; nothing for a one-shot agent (read-only) or before the session and its subagents are known.
 */
function viewTarget(
	session: Session | undefined,
	conversation: number,
	child: Child | undefined,
): CommandTarget | undefined {
	if (!session || child?.kind === "agent") return undefined;
	if (child)
		return {
			type: "conversation",
			id: conversationTargetId(session.id, conversation),
			kind: "Conversation",
			label: child.name,
		};
	return session.main === conversation
		? { type: "session", id: session.id, kind: "Session", label: session.title }
		: undefined;
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
	const objects = usePageObjects();
	// The catalog as the owner or a guest sees it (`worker` is a session worker's).
	const sessions = liveIn(objects.sessions, "owner", "guest");
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
			void nav.replace(NEW_SESSION, current);
		}
	}, [listed, session, nav, sessionId, toast]);
	// Who this browser is, as the server last said: kept while reconnecting (`useOwner`), so the composer stays.
	const { access } = objects;
	const liveGrant = useReadable(liveIn(access, "guest")?.grant);
	const owner = useOwner();
	const lastGrant = useRef(liveGrant);
	// Taken while the object is live, a removed grant (null) included.
	if (useStatus(access) === "live") lastGrant.current = liveGrant;
	const grant = owner ? undefined : lastGrant.current;
	const { fail } = useComposerState();
	const [resources, setDefault] = useModelResources(fail);
	const subagents = liveIn(objects.subagents, "reader");
	const children = useReadable(subagents?.children);
	const child = children?.[sessionId]?.find((entry) => entry.conversationId === conversationId);
	// A code mode script's one-shot agent: read-only, opened from the script's tool card.
	const oneShot = child?.kind === "agent";
	useCommandRouteTarget(viewTarget(session, conversationId, child));
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
	const workers = liveIn(objects.status, "reader");
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
	// Held with the view, not once the subagent list names the child: Archive works right after load.
	const subagentControl = useObject(SubagentControl, canWrite ? { session: sessionId } : undefined);
	// The bar's archived mark flips at the tap.
	const [archived, archive] = useOptimisticCall(child?.archived ?? false, (_, next: boolean) => next, fail);
	const composer = useComposerState();
	const {
		draft,
		setDraft,
		steer,
		setSteer,
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
		focus,
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
			focus();
		},
		[setReplyTo, focus],
	);
	// Kept while reconnecting, as the composer is (`canWrite`).
	const replying = canWrite && canReply ? replyTo : undefined;
	// `@`/Tab file completion for participants; in chat mode (`canReply`) the agent's mention (`@pi`) is offered first.
	const { composer: composerRef } = useFrame();
	const fileCompletion = useFileCompletion(
		composerRef,
		setDraft,
		canWrite ? { session: sessionId, conversation: conversationId } : undefined,
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
			focus();
		},
		[setDraft, focus],
	);
	// Who may write is known before the chat object is live (`canWrite`): drafts hold at once.
	useRestoredDrafts(sessionId, conversationId, canWrite, restore);
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
	const perform = useCallback((action: Promise<unknown> | undefined) => void action?.catch(fail), [fail]);
	// Plugins show their own display-only entry kinds (chat-mode's chat messages) as people's messages.
	const entryKinds = useRegistry(TranscriptEntries);
	const display = useCallback((kind: string, data: unknown) => entryKinds.get(kind)?.(data), [entryKinds]);
	const transcript = useMemo(
		() => (pages ? buildTranscript(pages.view, display, pages.filling) : undefined),
		[pages, display],
	);
	const stats = useReadable(chat?.stats) ?? undefined;
	// Messages sent from here that the server does not show yet (outbox.ts): shown as they will look, a person's
	// message at the end, or a queued input while a run is busy. An accepted one is shown by the server once the view
	// has an entry newer than any before it was sent, or, if a run was busy when its send started, once its queued input
	// is listed. One sent to an idle conversation is listed as queued only until the run it starts takes it, and the
	// server's state can arrive before the send's answer: it stays a message until its entry shows, never turning into a
	// queued row for a moment (the composer would move).
	const outbox = outboxOf(`${sessionId}#${conversationId}`);
	const outgoing = useSyncExternalStore(outbox.subscribe, outbox.snapshot);
	const newestEntry = view?.entries.at(-1)?.id ?? 0;
	const newest = useRef(newestEntry);
	newest.current = newestEntry;
	const busy = transcript?.busy ?? false;
	// Where each message's first send started: the newest entry then, and whether no run was busy (written by the sender).
	const started = useRef(new Map<string, { after: number; idle: boolean }>()).current;
	const queuedIds = useMemo(() => new Set(transcript?.queued.map((item) => item.id)), [transcript]);
	const shownByServer = useCallback(
		(message: Outgoing) =>
			message.sent !== undefined &&
			((!started.get(message.id)?.idle && queuedIds.has(message.sent.submissionId)) ||
				newestEntry > message.sent.after),
		[started, queuedIds, newestEntry],
	);
	useEffect(() => {
		outbox.settle(shownByServer);
		for (const id of started.keys()) if (!outgoing.some((message) => message.id === id)) started.delete(id);
	}, [outbox, shownByServer, started, outgoing]);
	// Not shown by the server yet; a message in flight whose entry has arrived before the answer already is.
	const pending = useMemo(
		() =>
			outgoing.filter((message) => {
				const start = started.get(message.id);
				return !shownByServer(message) && (!start || newestEntry <= start.after);
			}),
		[outgoing, shownByServer, started, newestEntry],
	);
	const pendingQueued = useMemo(
		() => (busy ? pending.filter((message) => !started.get(message.id)?.idle) : []),
		[pending, busy, started],
	);
	// The server's queued inputs, without those still shown as messages sent from here.
	const serverQueued = useMemo(() => {
		const sentIds = new Set(pending.map((message) => message.sent?.submissionId));
		return transcript?.queued.filter((item) => !sentIds.has(item.id)) ?? [];
	}, [transcript, pending]);
	// Before the server shows the conversation (a new session's first message), the messages sent from here show alone.
	const shown = useMemo(() => {
		const messages = pending.filter((message) => !pendingQueued.includes(message));
		if (!messages.length) return transcript;
		return transcript
			? { ...transcript, items: [...transcript.items, ...messages.map((message) => message.item)] }
			: outgoingTranscript(messages);
	}, [transcript, pending, pendingQueued]);
	// Until the live view arrives (the kept copy shows), whether the agent works is not known yet.
	const known = liveView !== undefined;
	// How tools' calls show: contributed by the plugins that own them.
	const tools = useRegistry(ToolActivities);
	// How much of a turn the transcript shows (settings.json `detail`, the owner's; guests see the default).
	const detail = useDetail(resources);
	const rows = useMemo(
		// Anything else: the default (`transcriptRows`' `DEFAULT_DETAIL`).
		() => (shown ? transcriptRows(shown.items, tools, shown.working, known, detail) : undefined),
		[shown, tools, known, detail],
	);
	const follow = useChatScroll({
		cache: `${sessionId}#${conversationId}`,
		...(rows ? { rows } : {}),
		estimates: rowEstimates,
		...(transcript && pages
			? { history: { more: transcript.earlier, loading: pages.loadingEarlier, size: transcript.items.length } }
			: {}),
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
		lightTap();
		setStopped(undefined);
		const id = crypto.randomUUID();
		outbox.add({
			id,
			text,
			files: [...files],
			whenBusy: steer ? "steer" : "followUp",
			...(replying ? { replyTo: replying } : {}),
			item: outgoingItem(id, text, files, author ?? (owner ? OWNER_AUTHOR : undefined)),
		});
		setDraft("");
		setFiles([]);
		setReplyTo(undefined);
		setSteer(true);
	};
	// The outbox sends while this conversation's chat object is live; the latest values, for its sender.
	const latest = useRef({ chat: writer, host, sessionId, conversationId, busy });
	latest.current = { chat: writer, host, sessionId, conversationId, busy };
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
				// The first try's: a retry after a lost answer must not count the entry the first one wrote.
				const start = started.get(message.id) ?? { after: newest.current, idle: !latest.current.busy };
				started.set(message.id, start);
				const { after } = start;
				// Uploads run side by side; one kept from an earlier try of this send is reused.
				const attachments = await Promise.all(
					message.files.map(async (file) => {
						if (file.session !== session) {
							file.uploaded = undefined;
							file.session = session;
						}
						file.uploaded ??= await upload(session, file.file);
						return file.uploaded;
					}),
				);
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
	}, [live, outbox, started, restore, setFiles, setReplyTo, setError]);
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
	// The chip and the picker show a model change at once; the conversation's state replaces it with the answer.
	const [choice, chooseModel] = useOptimisticCall<ModelChoice | undefined, ModelChoice>(
		session
			? {
					model: agentModel ?? session.model,
					thinkingLevel: transcript?.agent.thinkingLevel ?? thinkingLevelOf(session.thinkingLevel),
				}
			: undefined,
		(_, next) => next,
		fail,
	);
	// A move is long work (a job): the top bar says "Moving…" from the tap until the job is done; a refused move
	// (a busy session) shows as a failed operation in the sidebar.
	const operations = useReadable(liveIn(sessions, "owner")?.operations);
	const moveRunning =
		operations?.some(
			(operation) =>
				operation.phase === "running" && operation.kind === "relocate" && operation.session === sessionId,
		) ?? false;
	const [moving, relocate] = useOptimisticCall(moveRunning, () => true, fail);
	// A clone or fork into this session whose files are still being copied: nothing is sent until its worker runs.
	const copyTarget =
		operations?.some((operation) => operation.phase === "running" && operation.target === sessionId) ?? false;
	// A move of this session the worker refused (busy) or that failed: said in the toast once; the sidebar row keeps it
	// until dismissed.
	const failedMove = operations?.find(
		(operation) => operation.phase === "failed" && operation.kind === "relocate" && operation.session === sessionId,
	);
	const failedMoveText = failedMove?.phase === "failed" ? `Move failed: ${failedMove.error}` : undefined;
	useEffect(() => {
		if (failedMoveText) toast(failedMoveText);
	}, [failedMoveText, toast]);
	// Removed queued inputs leave the queue at once.
	const [queued, dequeue] = useOptimisticCall(
		serverQueued,
		(items, submissionId: number) => items.filter((item) => item.id !== submissionId),
		fail,
	);
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
	const toBottom = !follow.atBottom && (
		<button type="button" className="to-bottom" onClick={follow.toBottom} aria-label="Scroll to bottom">
			<DownIcon />
		</button>
	);
	// The dock (`Dock`): a subagent's bar above, then the composer, or a bar in its place for those who may not write.
	const subagentBar = child && (
		<div className="composer-wrap subagent-wrap">
			{/* A one-shot view has no composer, which otherwise carries this button. */}
			{oneShot && toBottom}
			<div className="subagent-bar">
				<span>
					{oneShot ? "One-shot agent of a script · read-only · " : ""}
					Tools: {child.tools.join(", ") || "none"}
					{!oneShot && viewLocation && ` · in ${locationLabel(viewLocation.env, viewLocation.cwd)}`}
					{!oneShot && !child.location && " · follows the session"}
					{archived ? " · archived" : ""}
				</span>
				{canWrite && !oneShot && subagentControl && (
					<button
						type="button"
						className="text-action"
						title={
							archived ? "Show it in the sidebar again" : "Stop it and move it to the sidebar's archived row"
						}
						onClick={() =>
							archive(!archived, () =>
								subagentControl.archive(
									{ conversation: child.conversationId, archived: !archived },
									BACKGROUND_CONTEXT,
								),
							)
						}
					>
						{archived ? "Restore" : "Archive"}
					</button>
				)}
				{canWrite && oneShot && busy && (
					<button type="button" className="round stop" aria-label="Stop" onClick={stop}>
						<StopIcon />
					</button>
				)}
			</div>
		</div>
	);
	const readOnlyBar = (!canWrite || failure) && (
		<div className="subagent-bar">
			<span>{failure ? "Session unavailable" : grant ? `Joined as ${grant.name} · read-only` : "Connecting…"}</span>
		</div>
	);
	const queuedRows = queued.length + pendingQueued.length > 0 && (
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
						<span>{message.whenBusy === "steer" ? "Steer" : "Queued"}</span> {message.text}
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
			{queued.map((item) => (
				<div key={item.id}>
					<button
						type="button"
						className="queue-edit"
						title="Move back to editor"
						onClick={() =>
							writer &&
							dequeue(item.id, async () => {
								const { text } = await writer.dequeue(
									{ submissionId: item.id, restore: true },
									BACKGROUND_CONTEXT,
								);
								if (text) restore([text], true);
							})
						}
					>
						<span>{item.mode === "steer" ? "Steer" : "Queued"}</span> {item.text}
					</button>
					<button
						type="button"
						className="queue-remove"
						aria-label="Remove from queue"
						onClick={() =>
							writer && dequeue(item.id, () => writer.dequeue({ submissionId: item.id }, BACKGROUND_CONTEXT))
						}
					>
						<CloseIcon />
					</button>
				</div>
			))}
		</div>
	);
	const place = useChatScreen(
		{
			screen: conversationKey({ session: sessionId, conversation: conversationId }),
			above: subagentBar,
			// A one-shot agent's view has no composer: its bar above has the Stop.
			...(oneShot && canWrite
				? {}
				: {
						composer: readOnlyBar
							? // As in Pi Mobile, the read-only bar has no scroll-down button.
								{ bar: readOnlyBar }
							: {
									toBottom,
									queued: queuedRows,
									props: {
										busy,
										steer,
										setSteer,
										disabled: copyTarget,
										onSend: send,
										onStop: stop,
										attaching,
										completion: fileCompletion,
										...(replying
											? { replying: { name: replying.name, onCancel: () => setReplyTo(undefined) } }
											: {}),
										children: <SlotList prefix="composer" />,
									},
									footer,
								},
					}),
		},
		follow.dock,
	);
	return (
		<>
			<TopBar session={session} child={child} owner={owner} moving={moving} />
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
						const catalog = liveIn(sessions, "owner");
						if (catalog) relocate(true, () => catalog.relocate({ id: sessionId, env, cwd }, BACKGROUND_CONTEXT));
						closeLayers();
					}}
				/>
			)}
			{modelSheet && owner && (
				<ModelPicker
					resources={resources}
					value={choice}
					onChange={(next) => {
						if (writer) chooseModel(next, () => writer.configure(next, BACKGROUND_CONTEXT));
					}}
					onDefault={setDefault}
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

			<ErrorToast />
			{place(
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
										{retrying ? "Retrying…" : "Retry"}
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
					) : shown ? (
						shown.items.length && rows ? (
							<SessionId.Provider value={sessionId}>
								<WorkingDirectory.Provider value={viewCwd}>
									<ToolActivityContext.Provider value={tools}>
										<OpenConversation.Provider value={openConversation}>
											<OneShotAgents.Provider value={oneShots}>
												<OpenWorkspaceFile.Provider value={canWrite ? openWorkspaceFile : undefined}>
													<OpenTerminal.Provider value={owner ? openTerminal : undefined}>
														<ReplyTo.Provider value={participant && canReply ? startReply : undefined}>
															<BranchFrom.Provider value={canBranch ? branchFrom : undefined}>
																<RevealEntry.Provider value={reveal}>
																	<FillGap.Provider value={fillGap}>
																		<Messages
																			transcript={shown}
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
									</ToolActivityContext.Provider>
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
				</div>,
			)}
		</>
	);
}

/** The new-session screen as the command menu's target: a model change there applies to the session about to start. */
const NEW_SESSION_TARGET: CommandTarget = { type: "new-session", id: "new", kind: "New session", label: "" };

function NewSession() {
	const connected = useConnected();
	const host = useHost();
	const owner = useOwner();
	const catalog = usePageObjects().sessions;
	const listed = useReadable(liveIn(catalog, "owner", "guest")?.sessions);
	// Only the owner creates sessions.
	const sessions = liveIn(catalog, "owner");
	const [resources, setDefault] = useModelResources(useComposerState().fail);
	const recent = useMemo(() => (listed ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt), [listed]);
	const {
		location: selectedLocation,
		setLocation,
		join,
		setJoin,
		choice: selectedChoice,
		setChoice,
	} = useNewSessionState();
	const location =
		selectedLocation ?? (recent[0] ? { env: recent[0].env ?? null, cwd: recent[0].cwd } : { env: null, cwd: "~" });
	const choice = newSessionChoice(selectedChoice, resources, recent[0]);
	useCommandRouteTarget(NEW_SESSION_TARGET);
	const contextWindow = resources?.models.find(
		(entry) => entry.provider === choice?.model.provider && entry.modelId === choice?.model.modelId,
	)?.contextWindow;
	const composer = useComposerState();
	const { draft, setDraft, files, setFiles, setError, steer, setSteer, setStopped } = composer;
	const cwdSheet = useSheet("cwd");
	const modelSheet = useSheet("model");
	const attaching = attachingOf(composer);
	// The first messages, shown at once while the session is created (session-start.ts).
	const start = useSyncExternalStore(sessionStart.subscribe, sessionStart.snapshot);
	const outgoing = useMemo(() => (start ? outgoingTranscript(start.messages) : undefined), [start]);
	const tools = useRegistry(ToolActivities);
	const rows = useMemo(() => (outgoing ? transcriptRows(outgoing.items, tools) : undefined), [outgoing, tools]);
	const follow = useChatScroll({ ...(rows ? { rows } : {}), estimates: rowEstimates });
	/**
	 * Sends the composer's message without waiting for the session or the connection: it leaves the composer and shows
	 * at once; the session is created when the page is connected, and its outbox delivers the message (session-start.ts).
	 */
	const send = () => {
		const text = draft.trim();
		if ((!text && !files.length) || !owner) return;
		if (!choice) {
			openLayer({ kind: "sheet", name: "model" });
			return;
		}
		lightTap();
		setStopped(undefined);
		const id = crypto.randomUUID();
		sessionStart.add(
			{
				id,
				text,
				files: [...files],
				whenBusy: steer ? "steer" : "followUp",
				item: outgoingItem(id, text, files, OWNER_AUTHOR),
			},
			// The page chooses the session's ID: a retried creation answers the same session.
			{ session: crypto.randomUUID(), location, choice, ...(join ? { join } : {}) },
		);
		setDraft("");
		setFiles([]);
		setSteer(true);
	};
	// The session is created while the owner's catalog is live; the session opens once it exists, if this screen still
	// shows (the outbox delivers the messages whenever the session is opened).
	const shownHere = useRef(true);
	useEffect(() => {
		shownHere.current = true;
		return () => {
			shownHere.current = false;
		};
	}, []);
	useEffect(() => {
		if (!connected || !sessions) {
			sessionStart.connect(undefined);
			return;
		}
		sessionStart.connect({
			create: async ({ session, location, choice, join }) => {
				// The new session's worker starts beside the creation, not after it (its start waits for the row): held
				// here and lingering for the session's view, which holds it next.
				const chat = host.hold(Chat, { session, conversation: 1 }, BACKGROUND_CONTEXT);
				try {
					await sessions.create(
						{
							id: session,
							env: location.env,
							cwd: location.cwd,
							model: choice.model,
							thinkingLevel: choice.thinkingLevel,
						},
						BACKGROUND_CONTEXT,
					);
					UI_LINGER.release(chat, Chat.name);
				} catch (error) {
					chat.release();
					throw error;
				}
				// A project's "+": the session joins the project once it exists, so a refused creation leaves no membership
				// behind; a failed join leaves the session as it is, and the toast says why.
				if (join) void join.run(session).catch(composer.fail);
			},
			// The server's own errors (a missing directory, an unknown model) refuse; a lost connection is tried again.
			refused: (error) => !isChordError(error) || refused(error),
			created: (session) => {
				// The next new session starts in no project unless its "+" is used again.
				setJoin(undefined);
				if (shownHere.current) navigate({ session }, { replace: true });
			},
			restore: (messages, error) => {
				setDraft((current) => joinDraft(...messages.map((message) => message.text), current));
				setFiles((current) => [...messages.flatMap((message) => message.files), ...current]);
				setError(errorText(error));
			},
		});
		return () => sessionStart.connect(undefined);
	}, [connected, sessions, host, setDraft, setFiles, setError, setJoin, composer.fail]);
	// Leaving the page loses a session not created yet: the browser asks first.
	useEffect(() => {
		if (!start) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [start]);
	const place = useChatScreen(
		{
			screen: conversationKey(NEW_SESSION),
			composer: owner
				? {
						props: { busy: false, steer, setSteer, disabled: false, onSend: send, attaching },
						footer: (
							<div className="session-usage">
								<div className="session-controls">
									<ModelControl resources={resources} {...(choice ? { choice } : {})} />
								</div>
								{/* The session's context bar, empty: the dock keeps its height when Send opens the session. */}
								<ContextUsage {...(contextWindow ? { used: 0, limit: contextWindow } : {})} />
							</div>
						),
					}
				: {
						bar: (
							<div className="subagent-bar">
								<span>Connecting…</span>
							</div>
						),
					},
		},
		follow.dock,
	);
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
					onDefault={setDefault}
					onClose={closeLayers}
				/>
			)}
			<ErrorToast />
			{place(
				<div className={outgoing ? "scroller transcript" : "scroller"} ref={follow.scroller}>
					{outgoing && rows ? (
						<Messages transcript={outgoing} rows={rows} list={follow.list} range={follow.range} />
					) : (
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
								{join && <small className="cwd-join">in {join.label}</small>}
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
					)}
				</div>,
			)}
		</>
	);
}

/** A guest's share ended: Pi Mobile clears the view and says so in its toast; nothing reconnects. */
function ShareEnded() {
	const place = useChatScreen(undefined);
	return (
		<>
			<TopBar />
			<button type="button" className="toast">
				This share has ended.
			</button>
			{place(<div className="scroller" />)}
		</>
	);
}

function Main() {
	const nav = useNavigation();
	const route = useRoute();
	const ended = useShareEnded();
	const owner = useOwner();
	const access = useObject(Access, {});
	const sessions = useObject(Sessions, {});
	const subagents = useObject(Subagents, {});
	const status = useObject(SessionStatus, {});
	const models = useObject(Models, owner ? {} : undefined);
	const envs = useObject(Envs, owner ? {} : undefined);
	const projects = useObject(Projects, owner ? {} : undefined);
	const objects = useMemo(
		() => ({ sessions, access, subagents, status, models, envs, projects }),
		[sessions, access, subagents, status, models, envs, projects],
	);
	const grant = useReadable(liveIn(access, "guest")?.grant);
	// A guest stays within the sessions shared with it; anywhere else it lands in the one shared or joined last.
	useEffect(() => {
		if (grant && !grantMode(grant, route.session)) void nav.replace(conversationRoute(route, grant.session), route);
	}, [grant, route, nav]);
	// The frame outlives the screens in it: its dock, with the one composer, stays while they change.
	const [view, setView] = useState<HTMLDivElement | null>(null);
	const [dock, setDock] = useState<HTMLDivElement | null>(null);
	const [contents] = useState(() => new DockContents());
	const composer = useRef<HTMLTextAreaElement>(null);
	const frame = useMemo(() => ({ view, dock, contents, composer }), [view, dock, contents]);
	// A short link (`/s/<id>`) opens the session's main conversation as last known here: no hold of conversation 1
	// first and no redirect after the catalog arrives (the conversation view corrects a stale guess).
	const shownConversation = route.session && route.conversation === 1 ? knownMain(route.session) : route.conversation;
	useEffect(() => {
		if (route.session && shownConversation !== route.conversation)
			void nav.replace(conversationRoute(route, route.session, shownConversation), route);
	}, [route, shownConversation, nav]);
	const conversation = route.session && `${route.session}:${shownConversation}`;
	return (
		<PageObjectsContext.Provider value={objects}>
			<ChatFrame.Provider value={frame}>
				{ended ? (
					<ShareEnded />
				) : route.session ? (
					<Slot name="chat-content">
						<Slot name="chat-attribution">
							<SessionChat key={conversation} sessionId={route.session} conversationId={shownConversation} />
						</Slot>
					</Slot>
				) : route.newSession ? (
					<NewSession />
				) : (
					// Home: what a plugin shows there (the Familiar opens its session), else the new-session screen.
					<Slot name="home" fallback={<NewSession />} />
				)}
				{/* The transcript of the screen above goes into the view (`useChatScreen`), the dock floats over its bottom. */}
				<div className="chat">
					<div className="chat-view" ref={setView} />
					<Dock frame={frame} dockRef={setDock} />
				</div>
				{/* Below the chat, per conversation (the bottom terminal panel). */}
				{conversation && !ended && <Slot key={conversation} name="chat-bottom" />}
			</ChatFrame.Provider>
		</PageObjectsContext.Provider>
	);
}

export default defineFacet((host, self) => {
	// The chat plugin defines the transcript's entry displays (chat-mode adds its own): served on the page too.
	serveKeyed(host, TranscriptEntries);
	self.contribute(Slots, { main: Main });
	self.contribute(Commands, MODEL_COMMANDS);
	self.contribute(CommandPages, MODEL_PAGES);
});
