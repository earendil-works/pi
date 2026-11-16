// Mobile's app-scoped editor state: navigation must not discard an unsent draft, attachments or acknowledgement.
import {
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { fileReferences, referenceText, renameReferences } from "../runtime/references.ts";
import { errorText, useRoute } from "../runtime/web.tsx";
import { ComposerFocus, conversationKey } from "./composer-focus.ts";
export type PickedFile = { key: string; file: File; preview?: string; uploaded?: string; session?: string };
/**
 * The composer's input as the page's code uses it: the draft's text with the caret as offsets into it (UTF-16, as a
 * textarea's), focus, and placing picked files' references at the caret or at a point (a drop).
 */
export type DraftInput = {
	readonly value: string;
	readonly selectionStart: number;
	setSelectionRange(start: number, end: number): void;
	focus(): void;
	insertFiles(files: readonly PickedFile[], at?: { readonly x: number; readonly y: number }): void;
};

/** A picked file's reference in the draft: `![name](attachment:<key>)` for an image, `[name](attachment:<key>)` else. */
export function pickedReference(file: PickedFile): string {
	return referenceText(file.file.name, file.key, file.preview !== undefined);
}

/** The picked files the draft references, in the draft's order: what a send uploads (removed pills' files stay out). */
export function referencedFiles(draft: string, files: readonly PickedFile[]): PickedFile[] {
	const byKey = new Map(files.map((file) => [file.key, file]));
	const picked = new Set<PickedFile>();
	for (const reference of fileReferences(draft)) {
		const file = byKey.get(reference.id);
		if (file) picked.add(file);
	}
	return [...picked];
}
/** The message the next send answers: an entry of the current conversation, and whose it is (for display only). */
export type ReplyTarget = { entryId: number; name: string };
type State = {
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	files: PickedFile[];
	setFiles: Dispatch<SetStateAction<PickedFile[]>>;
	error: string | undefined;
	setError: Dispatch<SetStateAction<string | undefined>>;
	/** Shows a failed call's error in the app's toast (an optimistic guess rolled back, an action refused). */
	fail: (error: unknown) => void;
	stopped: { sessionId: string; conversationId: number } | undefined;
	setStopped: Dispatch<SetStateAction<{ sessionId: string; conversationId: number } | undefined>>;
	viewer: string;
	/** Picks files and places their references at the composer's caret, or at `at` (a drop's point) when it is in it. */
	addFiles: (files: File[], at?: { readonly x: number; readonly y: number }) => void;
	replyTo: ReplyTarget | undefined;
	setReplyTo: Dispatch<SetStateAction<ReplyTarget | undefined>>;
	/** Whether this conversation accepts replies now; a plugin turns it on (chat-mode, while chat mode is on). */
	canReply: boolean;
	setCanReply: Dispatch<SetStateAction<boolean>>;
	/** The agent's name to mention here (chat-mode's setting, "Pi" by default), offered as `@name` with replies. */
	mentionName: string;
	setMentionName: Dispatch<SetStateAction<string>>;
	/** Focuses the composer now, for an action in the conversation shown (a reply, restored text, dropped files). */
	focus: ComposerFocus["focus"];
	/** Focuses an opened conversation's composer when it shows, unless a touch opened it (`ComposerFocus`). */
	focusWhenOpen: ComposerFocus["focusWhenOpen"];
	/** The composer's input, as it mounts (and null as it goes). */
	registerInput: (input: DraftInput | null) => void;
	/** The chat's dock tells which screen it shows, after the commit that put its composer in place. */
	screenShown: ComposerFocus["shown"];
};
const Context = createContext<State | undefined>(undefined);
export function ComposerState({ children }: { children: ReactNode }) {
	const route = useRoute();
	const [draft, setDraft] = useState("");
	const [files, setFiles] = useState<PickedFile[]>([]);
	const [error, setError] = useState<string>();
	const fail = useCallback((failure: unknown) => setError(errorText(failure)), []);
	const [stopped, setStopped] = useState<State["stopped"]>();
	const viewer = useRef(crypto.randomUUID());
	const [replyTo, setReplyTo] = useState<ReplyTarget>();
	const [canReply, setCanReply] = useState(false);
	const [mentionName, setMentionName] = useState("Pi");
	const [composerFocus] = useState(() => new ComposerFocus());
	const input = useRef<DraftInput | null>(null);
	const registerInput = useCallback(
		(element: DraftInput | null) => {
			input.current = element;
			composerFocus.register(element);
		},
		[composerFocus],
	);
	// Whether the person's last press was a touch, for the opens that focus a composer.
	useEffect(() => composerFocus.listen(), [composerFocus]);
	const key = conversationKey(route);
	// A reply target is an entry of one conversation: switching conversations drops it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation changes.
	useEffect(() => setReplyTo(undefined), [key]);
	// The Stop notice belongs to the conversation it was given in, as in Pi Mobile: another conversation clears it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation changes.
	useEffect(() => setStopped(undefined), [key]);
	useEffect(() => {
		try {
			const saved: unknown = JSON.parse(sessionStorage.getItem("p2-draft") ?? "null");
			if (saved && typeof saved === "object" && "key" in saved && "text" in saved && saved.key === key)
				// Its files went with the page: references to them keep only their names.
				setDraft((current) => current || renameReferences(String(saved.text), () => undefined));
		} catch {}
	}, [key]);
	const saved = useRef("");
	useEffect(() => {
		if (draft === saved.current) return;
		saved.current = draft;
		try {
			if (draft) sessionStorage.setItem("p2-draft", JSON.stringify({ key, text: draft }));
			else sessionStorage.removeItem("p2-draft");
		} catch {}
	}, [draft, key]);
	const addFiles = (chosen: File[], at?: { readonly x: number; readonly y: number }) => {
		const large = chosen.find((file) => file.size > 25 * 1024 * 1024);
		if (large) setError(`${large.name} is larger than 25 MB`);
		const picked: PickedFile[] = chosen
			.filter((file) => file.size <= 25 * 1024 * 1024)
			.map((file) => ({
				key: crypto.randomUUID(),
				file,
				...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
			}));
		if (!picked.length) return;
		setFiles((current) => [...current, ...picked]);
		// Without a composer on screen the references go at the draft's end.
		if (input.current) input.current.insertFiles(picked, at);
		else setDraft((current) => current + picked.map(pickedReference).join(" "));
	};
	return (
		<Context.Provider
			value={{
				draft,
				setDraft,
				files,
				setFiles,
				error,
				setError,
				fail,
				stopped,
				setStopped,
				viewer: viewer.current,
				addFiles,
				replyTo,
				setReplyTo,
				canReply,
				setCanReply,
				mentionName,
				setMentionName,
				focus: composerFocus.focus,
				focusWhenOpen: composerFocus.focusWhenOpen,
				registerInput,
				screenShown: composerFocus.shown,
			}}
		>
			{children}
		</Context.Provider>
	);
}
export function useComposerState(): State {
	const state = useContext(Context);
	if (!state) throw new Error("Missing app composer state");
	return state;
}
