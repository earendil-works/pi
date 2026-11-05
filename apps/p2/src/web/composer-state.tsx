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
import { errorText, useRoute } from "../runtime/web.tsx";
export type PickedFile = { key: string; file: File; preview?: string; uploaded?: string; session?: string };
/** The message the next send answers: an entry of the current conversation, and whose it is (for display only). */
export type ReplyTarget = { entryId: number; name: string };
type State = {
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	files: PickedFile[];
	setFiles: Dispatch<SetStateAction<PickedFile[]>>;
	steer: boolean;
	setSteer: Dispatch<SetStateAction<boolean>>;
	error: string | undefined;
	setError: Dispatch<SetStateAction<string | undefined>>;
	/** Shows a failed call's error in the app's toast (an optimistic guess rolled back, an action refused). */
	fail: (error: unknown) => void;
	stopped: { sessionId: string; conversationId: number } | undefined;
	setStopped: Dispatch<SetStateAction<{ sessionId: string; conversationId: number } | undefined>>;
	viewer: string;
	addFiles: (files: File[]) => void;
	replyTo: ReplyTarget | undefined;
	setReplyTo: Dispatch<SetStateAction<ReplyTarget | undefined>>;
	/** Whether this conversation accepts replies now; a plugin turns it on (chat-mode, while chat mode is on). */
	canReply: boolean;
	setCanReply: Dispatch<SetStateAction<boolean>>;
	/** The agent's name to mention here (chat-mode's setting, "Pi" by default), offered as `@name` with replies. */
	mentionName: string;
	setMentionName: Dispatch<SetStateAction<string>>;
};
const Context = createContext<State | undefined>(undefined);
export function ComposerState({ children }: { children: ReactNode }) {
	const route = useRoute();
	const [draft, setDraft] = useState("");
	const [files, setFiles] = useState<PickedFile[]>([]);
	const [steer, setSteer] = useState(true);
	const [error, setError] = useState<string>();
	const fail = useCallback((failure: unknown) => setError(errorText(failure)), []);
	const [stopped, setStopped] = useState<State["stopped"]>();
	const viewer = useRef(crypto.randomUUID());
	const [replyTo, setReplyTo] = useState<ReplyTarget>();
	const [canReply, setCanReply] = useState(false);
	const [mentionName, setMentionName] = useState("Pi");
	const key = route.session ? `${route.session}:${route.conversation}` : "new";
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
				setDraft((current) => current || String(saved.text));
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
	const addFiles = (picked: File[]) => {
		const large = picked.find((file) => file.size > 25 * 1024 * 1024);
		if (large) setError(`${large.name} is larger than 25 MB`);
		setFiles((current) => [
			...current,
			...picked
				.filter((file) => file.size <= 25 * 1024 * 1024)
				.map((file) => ({
					key: crypto.randomUUID(),
					file,
					...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
				})),
		]);
	};
	return (
		<Context.Provider
			value={{
				draft,
				setDraft,
				files,
				setFiles,
				steer,
				setSteer,
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
