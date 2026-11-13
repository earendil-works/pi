import type { Held, Location } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, filePreview, follow } from "@p2/app/v1";
import {
	ChevronIcon,
	CloseIcon,
	CommentIcon,
	DiffIcon,
	FileIcon,
	FolderIcon,
	type Navigation,
	QueryCache,
	RefreshIcon,
	routeKey,
	SearchIcon,
	Slot,
	TerminalIcon,
	useDragSize,
	useScrollMemory,
	type WorkspaceFileRoute,
	type WorkspaceRoute,
	type WorkspaceTab,
} from "@p2/app/v1/web";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Workspace } from "./contract.ts";
import { type CommentEditor, type FileView, type ReviewComment, reviewMessage, WorkspaceFile } from "./file.tsx";
import { type FuzzyMatch, rankFiles } from "./fuzzy.ts";
import type { WorkspaceChange, WorkspaceCommit, WorkspaceQuery, WorkspaceResult } from "./protocol.ts";
import { showWorkspaceTab } from "./tabs.ts";

const LOG_PAGE = 30;
/** Name filter results shown, best first. */
const FILTER_RESULTS = 200;
/** Narrowest chat and file column for which a file opens beside the list instead of in its place. */
const SPLIT_MIN = 480;
/** Workspace answers by session, conversation and query (see WorkspacePanel's load). */
const results = new QueryCache<unknown>(300);
/** Expanded folders of the Files tree by session and conversation, kept while the page lives. */
const expandedFolders = new Map<string, ReadonlySet<string>>();

/** `text` with the matched ranges emphasized; ranges may run past its end. */
function Highlight({ text, matches }: { text: string; matches?: FuzzyMatch[] }) {
	const parts: ReactNode[] = [];
	let at = 0;
	for (const match of matches ?? []) {
		const start = Math.max(at, match.start);
		const end = Math.min(text.length, match.end);
		if (end <= start) continue;
		if (start > at) parts.push(text.slice(at, start));
		parts.push(
			<strong key={start} className="fuzzy-hit">
				{text.slice(start, end)}
			</strong>,
		);
		at = end;
	}
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/**
 * The conversation's answers that a change in its working tree can alter. A commit and a file or diff at a commit
 * (`file:<hash>:path`, `diff:<mode>:<hash>:path`) stay valid.
 */
function invalidate(sessionId: string, conversationId: number): void {
	const scope = `${sessionId}\0${conversationId}\0`;
	results.invalidate(
		(key) => key.startsWith(scope) && !/^(commit:|file:[^:]|diff:[^:]*:[^:])/.test(key.slice(scope.length)),
	);
}

function ago(time: number): string {
	const seconds = Math.max(0, (Date.now() - time) / 1000);
	if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d`;
	return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}
/** `key` identifies what was requested: a refetch of the same key keeps showing the old value. */
type Loaded<T> = { key?: string; value?: T; error?: string; loading: boolean };
type ChangeNode = { name: string; path: string; children: ChangeNode[]; change?: WorkspaceChange };

function size(bytes: number): string {
	return bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What a status letter pair means, for the change list's tooltip. */
function describe(status: string): string {
	if (status === "??") return "untracked";
	if (status.includes("U") || status === "AA" || status === "DD") return "conflict";
	const letter = status[1] !== "." ? status[1] : status[0];
	const staged = status[0] !== "." ? "staged " : "";
	return `${staged}${{ M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed" }[letter ?? ""] ?? "changed"}`;
}

function letter(status: string): string {
	return status === "??" ? "?" : ((status[1] !== "." ? status[1] : status[0]) ?? "?");
}

/** Changed paths as a directory tree; single-child directory chains merge into one row (`src/web`). */
export function changeTree(changes: readonly WorkspaceChange[]): ChangeNode[] {
	const root: ChangeNode = { name: "", path: "", children: [] };
	for (const change of changes) {
		let node = root;
		const segments = change.path.split("/");
		segments.forEach((segment, index) => {
			const path = segments.slice(0, index + 1).join("/");
			let child = node.children.find(
				(entry) => entry.name === segment && !entry.change === index < segments.length - 1,
			);
			if (!child) {
				child = { name: segment, path, children: [] };
				node.children.push(child);
			}
			if (index === segments.length - 1) child.change = change;
			node = child;
		});
	}
	const compact = (node: ChangeNode): ChangeNode => {
		let current = node;
		while (!current.change && current.children.length === 1 && !current.children[0]?.change) {
			const only = current.children[0] as ChangeNode;
			current = { ...only, name: `${current.name}/${only.name}` };
		}
		return {
			...current,
			children: current.children
				.map(compact)
				.sort((a, b) => Number(Boolean(a.change)) - Number(Boolean(b.change)) || a.name.localeCompare(b.name)),
		};
	};
	// The root itself never merges into its only child.
	return compact({ ...root, change: { path: "", status: "" } }).children;
}

function initialView(path: string): FileView {
	const kind = filePreview(path)?.kind;
	return kind === "image" || kind === "audio" || kind === "video" || /\.(md|markdown)$/i.test(path)
		? "preview"
		: "file";
}

// Right-hand panel for the viewed conversation's working directory. All data comes
// from that conversation's execution environment via the worker; media and downloads
// use the separately authorized /workspace-file endpoint. Where it is (tab, folder,
// file, commit, search) is part of the route: folders, files and commits are steps.
export function WorkspacePanel({
	workspace,
	nav,
	route,
	sessionId,
	conversationId,
	attached,
	unavailable,
	onRetry,
	cwd,
	where,
	label,
	owner,
	onSend,
}: {
	workspace: Held<typeof Workspace> | undefined;
	nav: Navigation;
	route: WorkspaceRoute;
	sessionId: string;
	conversationId: number;
	/** The conversation's snapshot arrived: the server answers workspace queries only for the viewed conversation. */
	attached: boolean;
	/** Why the workspace could not be opened, while it is not attached; with `onRetry` to open it again. */
	unavailable?: string;
	onRetry?: () => void;
	cwd: string;
	/** Where the conversation works, as people read it (`gpu:/path`). */
	where?: string;
	/** A location as people read it: the header shows where the workspace is really open once it answered. */
	label?: (location: Location) => string;
	/** Terminals are a shell on the session's machine: only the owner gets them. */
	owner: boolean;
	/** Deliver review comments as the user's next message; absent for viewers who cannot send. */
	onSend?: (text: string) => Promise<void>;
}) {
	const { tab, directory, file: selection, commit: openCommit, search: submitted } = route;
	// Docked with room for a file beside the list (measured below): Files, Changes and Search then show the open file
	// to the left of their list instead of in its place. Phones and narrow windows keep one column.
	const [roomy, setRoomy] = useState(false);
	const split = roomy && selection !== undefined && (tab === "files" || tab === "changes" || tab === "search");
	// Changes applied to the latest route, not this render's: queued steps may be pending.
	const update = (change: (current: WorkspaceRoute) => WorkspaceRoute) => (current: typeof nav.route) => ({
		...current,
		...(current.workspace ? { workspace: change(current.workspace) } : {}),
	});
	const step = (next: Partial<WorkspaceRoute>) =>
		void nav.push(update((current) => ({ ...current, ...next }))(nav.route));
	// Folders expand in place (not a step). The last expanded folder is where uploads go; collapsing it or a folder
	// around it moves that to the collapsed folder's parent.
	const toggleFolder = (path: string) => {
		const open = !expanded.has(path);
		const next = new Set(expanded);
		if (open) {
			next.add(path);
			prefetch(`list:${path}`, { kind: "list", path });
		} else next.delete(path);
		setExpanded(next);
		const current = nav.route.workspace?.directory ?? "";
		const target = open
			? path
			: current === path || current.startsWith(`${path}/`)
				? path.slice(0, Math.max(0, path.lastIndexOf("/")))
				: current;
		if (target !== current) void nav.replace(update((workspace) => ({ ...workspace, directory: target }))(nav.route));
	};
	// Opening a file is a step; leaving it goes up to the list it was opened from.
	const setSelection = (next: WorkspaceFileRoute | undefined) => {
		if (next && selection && routeKey(next) === routeKey(selection)) return;
		if (next?.view === "changes")
			prefetch(`diff:context-3:${next.commit ?? ""}:${next.path}`, {
				kind: "diff",
				path: next.path,
				context: 3,
				...(next.commit ? { commit: next.commit } : {}),
			});
		else if (next)
			prefetch(`file:${next.commit ?? ""}:${next.path}`, {
				kind: "file",
				path: next.path,
				...(next.commit ? { commit: next.commit } : {}),
			});
		if (next) step({ file: next });
		else void nav.close(update((current) => ({ ...current, file: undefined })));
	};
	const setOpenCommit = (hash: string | undefined) =>
		hash
			? step({ commit: hash, file: undefined })
			: void nav.close(update((current) => ({ ...current, commit: undefined, file: undefined })));
	const setSubmitted = (search: WorkspaceRoute["search"]) =>
		void nav.replace(update((current) => ({ ...current, search }))(nav.route));
	const setTab = (next: WorkspaceTab) => showWorkspaceTab(nav, next);
	const [contextLines, setContextLines] = useState(3);
	// Inputs start from the submitted search a restored entry carries.
	const [searchText, setSearchText] = useState(submitted?.text ?? "");
	const [include, setInclude] = useState(submitted?.include ?? "");
	const [exclude, setExclude] = useState(submitted?.exclude ?? "");
	const [filters, setFilters] = useState(Boolean(submitted?.include || submitted?.exclude));
	const searchKey = `search:${JSON.stringify(submitted)}`;
	const [search, setSearch] = useState<Loaded<Extract<WorkspaceResult, { kind: "search" }>>>({ loading: false });
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [wrap, setWrap] = useState(() => localStorage.getItem("pi-workspace-wrap") === "1");
	const [version, setVersion] = useState(0);
	// The Files tree: every shown folder's listing, by path ("" is the root).
	const [listings, setListings] = useState<Record<string, Loaded<Extract<WorkspaceResult, { kind: "list" }>>>>({});
	const folderKey = `${sessionId}\0${conversationId}`;
	const [expanded, setExpandedState] = useState<ReadonlySet<string>>(new Set());
	// A restored route's folder shows expanded, with the folders around it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the conversation changes, see below.
	useEffect(() => {
		const next = new Set(expandedFolders.get(folderKey));
		const segments = directory ? directory.split("/") : [];
		for (let index = 1; index <= segments.length; index++) next.add(segments.slice(0, index).join("/"));
		setExpandedState(next);
		// Only when the conversation changes: later folder changes come from the tree itself.
	}, [folderKey]);
	const setExpanded = (next: ReadonlySet<string>) => {
		setExpandedState(next);
		expandedFolders.set(folderKey, next);
	};
	const [fileFilter, setFileFilter] = useState("");
	const filterText = useDeferredValue(fileFilter.trim() ? fileFilter : "");
	const [fileIndex, setFileIndex] = useState<Loaded<Extract<WorkspaceResult, { kind: "files" }>>>({ loading: false });
	const [status, setStatus] = useState<Loaded<Extract<WorkspaceResult, { kind: "status" }>>>({ loading: true });
	const [place, setPlace] = useState<Loaded<Extract<WorkspaceResult, { kind: "place" }>>>({ loading: true });
	const [file, setFile] = useState<Loaded<Extract<WorkspaceResult, { kind: "file" }>>>({ loading: true });
	const [diff, setDiff] = useState<Loaded<Extract<WorkspaceResult, { kind: "diff" }>>>({ loading: true });
	// Draft review comments survive reloads, per conversation, until sent or discarded.
	const commentsKey = `pi-review:${sessionId}:${conversationId}`;
	const [comments, setCommentsState] = useState<ReviewComment[]>([]);
	useEffect(() => {
		try {
			const saved: unknown = JSON.parse(localStorage.getItem(commentsKey) ?? "[]");
			setCommentsState(Array.isArray(saved) ? (saved as ReviewComment[]) : []);
		} catch {
			setCommentsState([]);
		}
	}, [commentsKey]);
	const setComments = (next: ReviewComment[]) => {
		setCommentsState(next);
		if (next.length) localStorage.setItem(commentsKey, JSON.stringify(next));
		else localStorage.removeItem(commentsKey);
	};
	// The open comment box (new or edit) is kept too, so a reload mid-typing loses nothing.
	const editorKey = `pi-review-editor:${sessionId}:${conversationId}`;
	const [editor, setEditorState] = useState<CommentEditor>();
	useEffect(() => {
		try {
			const saved: unknown = JSON.parse(localStorage.getItem(editorKey) ?? "null");
			setEditorState(saved && typeof saved === "object" ? (saved as CommentEditor) : undefined);
		} catch {
			setEditorState(undefined);
		}
	}, [editorKey]);
	const setEditor = (next: CommentEditor | undefined) => {
		setEditorState(next);
		if (next) localStorage.setItem(editorKey, JSON.stringify(next));
		else localStorage.removeItem(editorKey);
	};
	const commented = new Set(comments.map((comment) => comment.path));
	// Sorted by file and line, so the agent reads them in order; sent comments leave the drafts.
	const send = (batch: ReviewComment[]) => {
		if (!onSend || sending || !batch.length) return;
		setSending(true);
		const ids = new Set(batch.map((comment) => comment.id));
		onSend(reviewMessage(batch.toSorted((a, b) => a.path.localeCompare(b.path) || a.end - b.end)))
			.then(() => setComments(comments.filter((comment) => !ids.has(comment.id))))
			.catch(() => {})
			.finally(() => setSending(false));
	};
	const [sending, setSending] = useState(false);
	// Branch history, paged; a live refresh reloads as many commits as are shown.
	const [log, setLog] = useState<{ commits: WorkspaceCommit[]; more: boolean; upstream?: string; error?: string }>({
		commits: [],
		more: false,
	});
	const shown = useRef(LOG_PAGE);
	const [commitDetail, setCommitDetail] = useState<Loaded<Extract<WorkspaceResult, { kind: "commit" }>>>({
		loading: false,
	});
	const [uploading, setUploading] = useState<string>();
	const [uploadError, setUploadError] = useState<string>();
	// Until the conversation is attached, queries wait instead of failing; attaching
	// changes this function, so every load runs again.
	const query = useCallback(
		async <T extends WorkspaceResult>(value: WorkspaceQuery): Promise<T> => {
			if (!workspace || !attached) return new Promise<T>(() => {});
			return (await workspace.query(value, BACKGROUND_CONTEXT)) as T;
		},
		[workspace, attached],
	);

	const fileUrl = (path: string) =>
		`/workspace-file?${new URLSearchParams({ session: sessionId, conversation: String(conversationId), path })}`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: another file starts with the default context.
	useEffect(() => setContextLines(3), [selection?.path]);

	// Native handle lifetime leases the watch; changes invalidate the same mobile cache without a heartbeat request.
	useEffect(() => {
		invalidate(sessionId, conversationId);
		let first = true;
		let pending: ReturnType<typeof setTimeout> | undefined;
		if (!workspace) return;
		const stop = follow(workspace.changes, () => {
			if (first) {
				first = false;
				return;
			}
			invalidate(sessionId, conversationId);
			clearTimeout(pending);
			pending = setTimeout(() => setVersion((current) => current + 1), 500);
		});
		return () => {
			clearTimeout(pending);
			stop?.();
		};
	}, [workspace, sessionId, conversationId]);

	// Answers are kept per conversation (results): Back and revisits show a fresh one without a request and a stale one
	// at once while it refreshes, and a tap's request (prefetch) is joined instead of repeated. Nothing is cached before
	// the conversation is attached, when queries wait without answering.
	const scoped = (key: string) => `${sessionId}\0${conversationId}\0${key}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scoped is recreated each render and depends only on sessionId and conversationId.
	const load = useCallback(
		<T,>(key: string, request: () => Promise<T>, set: Dispatch<SetStateAction<Loaded<T>>>) => {
			let current = true;
			const cached = attached ? (results.get(scoped(key)) as T | undefined) : undefined;
			if (cached !== undefined && results.fresh(scoped(key))) {
				set({ key, value: cached, loading: false });
				return;
			}
			// Live refreshes keep showing the previous value instead of flashing a spinner.
			set((previous) =>
				previous.key === key
					? { ...previous, loading: true }
					: cached !== undefined
						? { key, value: cached, loading: true }
						: { key, loading: true },
			);
			(attached ? (results.fetch(scoped(key), request) as Promise<T>) : request()).then(
				(value) => current && set({ key, value, loading: false }),
				(error: Error) => current && set({ key, error: error.message, loading: false }),
			);
			return () => {
				current = false;
			};
		},
		[attached, sessionId, conversationId],
	);
	/** Start loading what a tap opens, together with its navigation step. */
	const prefetch = (key: string, value: WorkspaceQuery) => {
		if (attached && !results.fresh(scoped(key))) results.prefetch(scoped(key), () => query(value));
	};
	// Only what is shown loads: a change under an open file reloads the file, not the folder listing behind it.
	const showsListing = tab === "files" && (!selection || split);
	const showsSearch = tab === "search" && (!selection || split);
	// Folders the tree shows: the root and each expanded folder inside a shown one that lists it.
	const shownFolders: string[] = [""];
	for (let index = 0; index < shownFolders.length; index++) {
		const folder = shownFolders[index] ?? "";
		for (const entry of listings[folder]?.value?.entries ?? []) {
			const path = folder ? `${folder}/${entry.name}` : entry.name;
			if (entry.kind === "directory" && expanded.has(path)) shownFolders.push(path);
		}
	}
	const shownKey = shownFolders.join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (!showsListing || filterText) return;
		const stops = shownKey.split("\0").map((path) =>
			load(
				`list:${path}`,
				() => query<Extract<WorkspaceResult, { kind: "list" }>>({ kind: "list", path }),
				(action) =>
					setListings((current) => ({
						...current,
						[path]: typeof action === "function" ? action(current[path] ?? { loading: true }) : action,
					})),
			),
		);
		return () => {
			for (const stop of stops) stop?.();
		};
	}, [shownKey, load, query, version, showsListing, filterText]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (!showsListing || !filterText) return;
		return load("files", () => query<Extract<WorkspaceResult, { kind: "files" }>>({ kind: "files" }), setFileIndex);
	}, [load, query, version, showsListing, filterText]);
	const filePaths = fileIndex.value?.paths;
	const ranked = useMemo(
		() => (filePaths && filterText ? rankFiles(filePaths, filterText, FILTER_RESULTS) : []),
		[filePaths, filterText],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(
		() => load("status", () => query<Extract<WorkspaceResult, { kind: "status" }>>({ kind: "status" }), setStatus),
		[load, query, version],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(
		() => load("place", () => query<Extract<WorkspaceResult, { kind: "place" }>>({ kind: "place" }), setPlace),
		[load, query, version],
	);
	const opened = place.value?.location;
	const shownWhere = opened && label ? label(opened) : where;
	const moveNote = place.value?.failed
		? `Moving the session to ${label ? label(place.value.failed.to) : place.value.failed.to.cwd} failed: ${place.value.failed.error}`
		: place.value?.pending
			? `The session moves to ${label ? label(place.value.pending) : place.value.pending.cwd} when its turn ends.`
			: undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (tab !== "changes") return;
		let current = true;
		query<Extract<WorkspaceResult, { kind: "log" }>>({
			kind: "log",
			skip: 0,
			limit: Math.min(shown.current, 500),
		}).then(
			(value) => current && setLog({ commits: value.commits, more: value.more, upstream: value.upstream }),
			(error: Error) => current && setLog((previous) => ({ ...previous, error: error.message })),
		);
		return () => {
			current = false;
		};
	}, [query, tab, version]);
	const loadMore = () => {
		const skip = log.commits.length;
		query<Extract<WorkspaceResult, { kind: "log" }>>({ kind: "log", skip, limit: LOG_PAGE }).then(
			(value) => {
				shown.current = skip + value.commits.length;
				setLog((previous) => ({
					...previous,
					commits: [...previous.commits.slice(0, skip), ...value.commits],
					more: value.more,
				}));
			},
			(error: Error) => setLog((previous) => ({ ...previous, error: error.message })),
		);
	};
	useEffect(() => {
		if (!openCommit) return;
		return load(
			`commit:${openCommit}`,
			() => query<Extract<WorkspaceResult, { kind: "commit" }>>({ kind: "commit", commit: openCommit }),
			setCommitDetail,
		);
	}, [load, query, openCommit]);
	const upload = async (picked: File[]) => {
		setUploadError(undefined);
		for (const entry of picked) {
			setUploading(entry.name);
			const params = new URLSearchParams({
				session: sessionId,
				conversation: String(conversationId),
				path: directory,
				name: entry.name,
			});
			try {
				const response = await fetch(`/workspace-upload?${params}`, {
					method: "POST",
					body: entry,
					credentials: "same-origin",
				});
				const result = (await response.json().catch(() => ({}))) as { error?: string };
				if (!response.ok) throw new Error(result.error ?? `Upload failed (${response.status})`);
			} catch (error) {
				setUploadError(`${entry.name}: ${error instanceof Error ? error.message : "upload failed"}`);
				break;
			}
		}
		setUploading(undefined);
		invalidate(sessionId, conversationId);
		setVersion((current) => current + 1);
	};
	const changes = status.value?.kind === "status" && status.value.repo ? status.value.changes : [];
	const commitChanges =
		commitDetail.key === `commit:${openCommit}` && commitDetail.value ? commitDetail.value.changes : [];
	const selectedChange = selection
		? (selection.commit ? commitChanges : changes).find((entry) => entry.path === selection.path)
		: undefined;
	// File and Preview need the file (unless deleted); Changes and a changed File need a diff.
	const needsFile = selection !== undefined && selection.view !== "changes" && !selectedChange?.status.includes("D");
	const diffMode =
		selection?.view === "changes"
			? `context-${contextLines}`
			: selection?.view === "file" && selectedChange
				? "full"
				: undefined;
	const at = selection?.commit;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selected path, not the selection object; version triggers refetches.
	useEffect(() => {
		if (!selection || !needsFile) return;
		return load(
			`file:${at ?? ""}:${selection.path}`,
			() =>
				query<Extract<WorkspaceResult, { kind: "file" }>>({
					kind: "file",
					path: selection.path,
					...(at ? { commit: at } : {}),
				}),
			setFile,
		);
	}, [load, query, selection?.path, at, needsFile, version]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selected path, not the selection object; version triggers refetches.
	useEffect(() => {
		if (!selection || !diffMode) return;
		return load(
			`diff:${diffMode}:${at ?? ""}:${selection.path}`,
			() =>
				query<Extract<WorkspaceResult, { kind: "diff" }>>({
					kind: "diff",
					path: selection.path,
					...(diffMode === "full" ? { full: true } : { context: contextLines }),
					...(at ? { commit: at } : {}),
				}),
			setDiff,
		);
	}, [load, query, selection?.path, at, diffMode, contextLines, version]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers refetches.
	useEffect(() => {
		if (!submitted || !showsSearch) return;
		return load(
			searchKey,
			() =>
				query<Extract<WorkspaceResult, { kind: "search" }>>({
					kind: "search",
					text: submitted.text,
					path: "",
					...(submitted.include ? { include: submitted.include } : {}),
					...(submitted.exclude ? { exclude: submitted.exclude } : {}),
				}),
			setSearch,
		);
	}, [load, query, submitted, searchKey, version, showsSearch]);

	const panel = useRef<HTMLElement>(null);
	// Each list, file and commit keeps its scroll position for Back. Keyed by the panel's
	// location only: a sheet opened beside the docked panel leaves it where it was.
	const scroller = useRef<HTMLDivElement>(null);
	// Beside an open file, the list is the same step as without it.
	// The upload folder changes without a step: it is not part of the location.
	const located = { ...route, directory: "" };
	useScrollMemory(
		scroller,
		routeKey({ sessionId, conversationId, route: split ? { ...located, file: undefined } : located }),
	);
	const previewScroller = useRef<HTMLDivElement>(null);
	useScrollMemory(previewScroller, routeKey({ sessionId, conversationId, route: located, preview: split }));
	// A changed filter starts its results at the top.
	const shownFilter = useRef(filterText);
	useEffect(() => {
		if (shownFilter.current === filterText) return;
		shownFilter.current = filterText;
		scroller.current?.scrollTo({ top: 0 });
	}, [filterText]);
	// Its width, dragged from the left edge and remembered; phones ignore it (full screen).
	const width = useDragSize("pi-workspace-width", "--workspace-width");
	// Room to split: the chat and the panel share what the sidebar leaves; the list keeps its width, and the chat and
	// the file column split the rest equally (flex in style.css). Their sum doesn't change when the split toggles.
	const column = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = panel.current;
		const main = element?.parentElement?.querySelector<HTMLElement>(":scope > .main");
		const list = column.current;
		if (!element || !main || !list) return;
		const docked = window.matchMedia("(min-width: 1280px)");
		const measure = () =>
			setRoomy(docked.matches && main.offsetWidth + element.offsetWidth - list.offsetWidth >= 2 * SPLIT_MIN);
		measure();
		const observer = new ResizeObserver(measure);
		for (const target of [element, main, list]) observer.observe(target);
		docked.addEventListener("change", measure);
		return () => {
			observer.disconnect();
			docked.removeEventListener("change", measure);
		};
	}, []);
	const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
		const element = panel.current;
		if (!element) return;
		const right = element.getBoundingClientRect().right;
		width.drag(event, element, (moved) => Math.min(Math.max(right - moved.clientX, 320), window.innerWidth * 0.7));
	};

	const rootName = cwd.replace(/\/+$/, "").split("/").pop() || "/";

	const terminal = tab === "terminal" && owner && !selection;
	// The open file: in place of the list, or beside it when split.
	let fileBody: ReactNode;
	if (selection) {
		const name = selection.path.slice(selection.path.lastIndexOf("/") + 1);
		const kind = filePreview(name)?.kind;
		const deleted = selectedChange?.status.includes("D") ?? false;
		// A commit's version has no working-tree URL, so no media preview or download.
		const previewable =
			!deleted &&
			(kind === "image" || kind === "audio" || kind === "video" || /\.(md|markdown)$/i.test(name)) &&
			!(at && kind !== undefined && kind !== "text");
		const views: FileView[] = [
			...(selectedChange ? (["changes"] as const) : []),
			...(deleted ? [] : (["file"] as const)),
			...(previewable ? (["preview"] as const) : []),
		];
		const current = (key: string, loaded: Loaded<unknown>) => (loaded.key === key ? loaded : undefined);
		const fileLoaded = current(`file:${at ?? ""}:${selection.path}`, file) as typeof file | undefined;
		const diffLoaded = diffMode
			? (current(`diff:${diffMode}:${at ?? ""}:${selection.path}`, diff) as typeof diff | undefined)
			: undefined;
		fileBody = (
			<WorkspaceFile
				path={selection.path}
				view={selection.view}
				views={views}
				file={needsFile ? fileLoaded?.value : undefined}
				diff={diffMode ? diffLoaded?.value : undefined}
				error={(needsFile ? fileLoaded?.error : undefined) ?? (diffMode ? diffLoaded?.error : undefined)}
				url={at ? undefined : fileUrl(selection.path)}
				commit={at}
				wrap={wrap}
				comments={comments}
				editor={editor}
				onEditor={setEditor}
				line={selection.line}
				contextLines={contextLines}
				onContext={setContextLines}
				onView={(view) =>
					void nav.replace(update((current) => ({ ...current, file: { ...selection, view } }))(nav.route))
				}
				onWrap={() => {
					localStorage.setItem("pi-workspace-wrap", wrap ? "0" : "1");
					setWrap(!wrap);
				}}
				onBack={() => setSelection(undefined)}
				closable={split}
				onComments={setComments}
				onSendOne={onSend && !sending ? (comment) => send([comment]) : undefined}
			/>
		);
	}
	let body: ReactNode;
	if (!terminal && !attached && unavailable !== undefined) {
		body = (
			<>
				<p className="notice error workspace-note">The workspace could not be opened: {unavailable}</p>
				{onRetry && (
					<button type="button" className="text-action workspace-note" onClick={onRetry}>
						Retry
					</button>
				)}
			</>
		);
	} else if (terminal) {
		body = <Slot name="workspace-terminal" />;
	} else if (selection && !split) {
		body = fileBody;
	} else if (tab === "files") {
		const indent = (depth: number) => ({ paddingLeft: `calc(var(--x) + ${depth * 14}px)` });
		const tree = (folder: string, depth: number): ReactNode[] => {
			const loaded = listings[folder];
			if (!loaded?.value)
				return [
					loaded?.error ? (
						<p key={`${folder}\0error`} className="notice error workspace-note" style={indent(depth)}>
							{loaded.error}
						</p>
					) : (
						<div key={`${folder}\0loading`} className="workspace-row" style={indent(depth)}>
							<span className="spinner" />
						</div>
					),
				];
			// Ignored entries show too, dimmed.
			const entries = loaded.value.entries;
			return [
				...entries.flatMap((entry) => {
					const path = folder ? `${folder}/${entry.name}` : entry.name;
					const className = `workspace-row ${entry.ignored ? "ignored" : ""}`;
					if (entry.kind === "directory") {
						const open = expanded.has(path);
						return [
							<button
								type="button"
								key={path}
								className={`${className} directory`}
								style={indent(depth)}
								aria-expanded={open}
								onClick={() => toggleFolder(path)}
							>
								<span className={`chev ${open ? "open" : ""}`}>
									<ChevronIcon size={12} />
								</span>
								<span className="workspace-name">{entry.name}</span>
							</button>,
							...(open ? tree(path, depth + 1) : []),
						];
					}
					return [
						<button
							type="button"
							key={path}
							className={className}
							style={indent(depth)}
							aria-current={split && selection?.path === path ? "true" : undefined}
							onClick={() => setSelection({ path, view: initialView(path) })}
						>
							<FileIcon />
							<span className="workspace-name">{entry.name}</span>
							<small>{entry.kind === "symlink" ? "link" : size(entry.size)}</small>
						</button>,
					];
				}),
				...(!entries.length
					? [
							<p key={`${folder}\0empty`} className="notice workspace-note" style={indent(depth)}>
								{folder ? "Empty folder." : "Empty directory."}
							</p>,
						]
					: []),
				...(loaded.value.truncated
					? [
							<p key={`${folder}\0truncated`} className="notice workspace-note" style={indent(depth)}>
								Showing the first 2,000 entries.
							</p>,
						]
					: []),
			];
		};
		body = (
			<>
				<div className="workspace-filter">
					<div className="search workspace-search">
						<SearchIcon />
						<input
							type="search"
							value={fileFilter}
							maxLength={200}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							onChange={(event) => setFileFilter(event.target.value)}
							onKeyDown={(event) => {
								// As in Quick Open: Enter opens the best match, Escape clears.
								const best = ranked[0];
								if (event.key === "Enter" && best)
									setSelection({ path: best.path, view: initialView(best.path) });
								else if (event.key === "Escape" && fileFilter) {
									event.stopPropagation();
									setFileFilter("");
								}
							}}
							placeholder="Go to file"
							aria-label="Go to file by name"
						/>
						{fileFilter && (
							<button type="button" className="text-action" onClick={() => setFileFilter("")}>
								Clear
							</button>
						)}
					</div>
					<label
						className="text-action workspace-upload"
						title={`Upload into ${directory ? `${rootName}/${directory}` : rootName}`}
					>
						{uploading ? `Uploading ${uploading}…` : `Upload to ${directory.split("/").pop() || rootName}`}
						<input
							type="file"
							multiple
							hidden
							disabled={uploading !== undefined}
							onChange={(event) => {
								void upload([...(event.target.files ?? [])]);
								event.target.value = "";
							}}
						/>
					</label>
				</div>
				{uploadError && <p className="notice error workspace-note">{uploadError}</p>}
				{filterText ? (
					fileIndex.error ? (
						<p className="notice error workspace-note">{fileIndex.error}</p>
					) : !filePaths ? (
						<div className="spinner large" />
					) : (
						<div className="workspace-list">
							{ranked.map(({ path, score }) => {
								const slash = path.lastIndexOf("/");
								return (
									<button
										type="button"
										key={path}
										className="workspace-row"
										aria-current={split && selection?.path === path ? "true" : undefined}
										onClick={() => setSelection({ path, view: initialView(path) })}
									>
										<FileIcon />
										<span className="workspace-name">
											<Highlight text={path.slice(slash + 1)} matches={score.labelMatch} />
											{slash > 0 && (
												<span className="muted">
													{" "}
													<Highlight text={path.slice(0, slash)} matches={score.descriptionMatch} />
												</span>
											)}
										</span>
									</button>
								);
							})}
							{!ranked.length && <p className="notice workspace-note">No matching files.</p>}
							{fileIndex.value?.truncated && (
								<p className="notice workspace-note">Only the first 50,000 files are searched.</p>
							)}
						</div>
					)
				) : (
					<div className="workspace-list workspace-tree">{tree("", 0)}</div>
				)}
			</>
		);
	} else if (tab === "comments") {
		const ordered = comments.toSorted((a, b) => a.path.localeCompare(b.path) || a.end - b.end);
		body = ordered.length ? (
			<div className="workspace-list">
				{ordered.map((comment) => (
					<div key={comment.id} className="comment-row">
						<button
							type="button"
							className="workspace-row"
							onClick={() =>
								// One step to the file (and its commit); Back returns to this list.
								step({
									file: {
										path: comment.path,
										view: comment.view,
										line: comment.end,
										...(comment.commit ? { commit: comment.commit } : {}),
									},
									commit: comment.commit,
								})
							}
						>
							<span className="workspace-name">
								<span className="muted">
									{comment.path}:{comment.end}
									{comment.commit ? ` @${comment.commit.slice(0, 8)}` : ""}
									{comment.view === "changes" ? " (diff)" : ""}
								</span>
								<br />
								<span className="comment-quote">{comment.quote}</span>
								<br />
								<span className="comment-text">{comment.text}</span>
							</span>
						</button>
						<span className="comment-actions">
							{onSend && (
								<button
									type="button"
									className="text-action"
									disabled={sending}
									onClick={() => send([comment])}
								>
									Send
								</button>
							)}
							<button
								type="button"
								className="icon-button"
								aria-label="Delete comment"
								onClick={() => setComments(comments.filter((entry) => entry.id !== comment.id))}
							>
								<CloseIcon />
							</button>
						</span>
					</div>
				))}
			</div>
		) : (
			<p className="notice workspace-note">No unsent comments. Tap a line number in a file or diff to comment.</p>
		);
	} else if (tab === "search") {
		const value = search.value;
		const filtered = Boolean(include.trim() || exclude.trim());
		const glob = (label: string, text: string, set: (value: string) => void, example: string) => (
			<label className="search workspace-search workspace-glob">
				<span>{label}</span>
				<input
					value={text}
					maxLength={500}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					onChange={(event) => set(event.target.value)}
					placeholder={example}
					aria-label={`Files to ${label}`}
				/>
			</label>
		);
		body = (
			<>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (searchText.trim()) setSubmitted({ text: searchText, include, exclude });
					}}
				>
					<div className="search workspace-search">
						<SearchIcon />
						<input
							type="search"
							value={searchText}
							maxLength={200}
							onChange={(event) => setSearchText(event.target.value)}
							placeholder="Search text in files"
							aria-label="Search text in files"
						/>
						<button
							type="button"
							className="text-action"
							aria-expanded={filters}
							onClick={() => setFilters(!filters)}
						>
							{filters || !filtered ? "Filters" : "Filters on"}
						</button>
					</div>
					{filters && (
						<>
							{glob("include", include, setInclude, "*.ts, src/")}
							{glob("exclude", exclude, setExclude, "*.test.ts, dist")}
						</>
					)}
					{/* Enter in any field submits the form. */}
					<button type="submit" hidden />
				</form>
				{search.error ? (
					<p className="notice error workspace-note">{search.error}</p>
				) : !submitted ? (
					<p className="notice workspace-note">
						Literal text; case-insensitive unless it has capitals. Ignored files are skipped.
						{filters &&
							" Filters take comma-separated globs such as *.ts, *.{ts,tsx} or src/, matching at any depth unless they start with ./."}
					</p>
				) : !value || search.key !== searchKey ? (
					<div className="spinner large" />
				) : (
					<div className="workspace-list">
						{value.matches.map((match, index) => (
							<button
								type="button"
								key={`${match.path}:${match.line}:${index}`}
								className="workspace-row match"
								aria-current={
									split && selection?.path === match.path && selection.line === match.line ? "true" : undefined
								}
								onClick={() => setSelection({ path: match.path, view: "file", line: match.line })}
							>
								<span className="workspace-name">
									<span className="muted">
										{match.path}:{match.line}
									</span>
									<br />
									{match.text.trim()}
								</span>
							</button>
						))}
						{!value.matches.length && <p className="notice workspace-note">No matches.</p>}
						{value.truncated && <p className="notice workspace-note">Showing the first matches.</p>}
					</div>
				)}
			</>
		);
	} else {
		const value = status.value;
		const render = (nodes: ChangeNode[], depth: number, commit?: string): ReactNode[] =>
			nodes.flatMap((node) => {
				const indent = { paddingLeft: `calc(var(--x) + ${depth * 14}px)` };
				if (node.change) {
					const change = node.change;
					return [
						<button
							type="button"
							key={node.path}
							className="workspace-row"
							style={indent}
							title={`${describe(change.status)}${change.from ? ` from ${change.from}` : ""}`}
							aria-current={
								split && selection?.path === change.path && selection.commit === commit ? "true" : undefined
							}
							onClick={() => setSelection({ path: change.path, view: "changes", ...(commit ? { commit } : {}) })}
						>
							<span className={`workspace-status status-${letter(change.status)}`}>{letter(change.status)}</span>
							<span className="workspace-name">{node.name}</span>
							{(() => {
								const count = comments.filter(
									(comment) => comment.path === change.path && comment.commit === commit,
								).length;
								return count ? (
									<small className="comment-count" title="Has review comments">
										{count} comment{count === 1 ? "" : "s"}
									</small>
								) : null;
							})()}
						</button>,
					];
				}
				const open = !collapsed.has(node.path);
				return [
					<button
						type="button"
						key={node.path}
						className="workspace-row directory"
						style={indent}
						aria-expanded={open}
						onClick={() =>
							setCollapsed((current) => {
								const next = new Set(current);
								if (open) next.add(node.path);
								else next.delete(node.path);
								return next;
							})
						}
					>
						<span className={`chev ${open ? "open" : ""}`}>
							<ChevronIcon size={12} />
						</span>
						<span className="workspace-name">{node.name}</span>
					</button>,
					...(open ? render(node.children, depth + 1, commit) : []),
				];
			});
		const detail = commitDetail.key === `commit:${openCommit}` ? commitDetail : undefined;
		const summary = log.commits.find((entry) => entry.hash === openCommit);
		body = openCommit ? (
			<div className="workspace-view">
				<div className="workspace-bars">
					<div className="workspace-bar">
						<button
							type="button"
							className="icon-button back"
							onClick={() => setOpenCommit(undefined)}
							aria-label="Back"
						>
							<ChevronIcon size={18} />
						</button>
						<span className="workspace-path">{summary?.subject ?? openCommit.slice(0, 8)}</span>
						<span className="workspace-commit mono">{openCommit.slice(0, 8)}</span>
					</div>
				</div>
				{detail?.error ? (
					<p className="notice error workspace-note">{detail.error}</p>
				) : !detail?.value ? (
					<div className="spinner large" />
				) : (
					<>
						<div className="commit-meta">
							<span className="muted">
								{detail.value.author} · {new Date(detail.value.time).toLocaleString()}
								{summary?.unpushed ? " · not pushed" : ""}
							</span>
							{detail.value.message.includes("\n") && (
								<pre className="commit-message">
									{detail.value.message.split("\n").slice(1).join("\n").trim()}
								</pre>
							)}
						</div>
						<div className="workspace-list">
							{render(changeTree(detail.value.changes), 0, openCommit)}
							{!detail.value.changes.length && <p className="notice workspace-note">No file changes.</p>}
							{detail.value.truncated && <p className="notice workspace-note">Change list truncated.</p>}
						</div>
					</>
				)}
			</div>
		) : status.error ? (
			<p className="notice error workspace-note">{status.error}</p>
		) : !value ? (
			<div className="spinner large" />
		) : !value.repo ? (
			<p className="notice workspace-note">Not a git repository.</p>
		) : (
			<>
				<p className="workspace-crumbs mono muted">
					{value.branch ?? "detached"}
					{log.upstream ? ` → ${log.upstream}` : ""}
				</p>
				{value.changes.length > 0 && (
					<>
						<h3 className="workspace-section">Uncommitted</h3>
						<div className="workspace-list">
							{render(changeTree(value.changes), 0)}
							{value.truncated && <p className="notice workspace-note">Change list truncated.</p>}
						</div>
					</>
				)}
				<h3 className="workspace-section">Commits</h3>
				<div className="workspace-list">
					{log.commits.map((entry) => (
						<button
							type="button"
							key={entry.hash}
							className={`workspace-row commit-row ${entry.unpushed ? "unpushed" : ""}`}
							title={entry.unpushed ? "Not pushed" : undefined}
							onClick={() => setOpenCommit(entry.hash)}
						>
							<span className="commit-dot" />
							<span className="workspace-name">
								{entry.subject}
								<br />
								<span className="muted">
									{entry.short} · {entry.author} · {ago(entry.time)}
								</span>
							</span>
						</button>
					))}
					{log.error && <p className="notice error workspace-note">{log.error}</p>}
					{!log.commits.length && !log.error && <p className="notice workspace-note">No commits.</p>}
					{log.more && (
						<button type="button" className="text-action workspace-note" onClick={loadMore}>
							Load more commits
						</button>
					)}
				</div>
			</>
		);
	}

	return (
		<aside className={`workspace ${split ? "split" : ""}`} aria-label="Workspace" ref={panel} style={width.style}>
			{/* The column stays the second child either way, so toggling the split never remounts the list. */}
			{split && (
				<section className="workspace-preview" aria-label="Open file">
					<div className="workspace-preview-body" ref={previewScroller}>
						{fileBody}
					</div>
				</section>
			)}
			<div className="workspace-column" ref={column}>
				<button
					type="button"
					className="workspace-resize"
					aria-label="Drag to resize workspace"
					tabIndex={-1}
					onPointerDown={startResize}
				/>
				<header className="workspace-head">
					<div className="workspace-tabs">
						{(
							[
								["files", "Files", <FolderIcon key="icon" size={20} />, 0],
								["changes", "Changes", <DiffIcon key="icon" />, changes.length],
								["search", "Search", <SearchIcon key="icon" size={20} />, 0],
								["comments", "Comments", <CommentIcon key="icon" />, comments.length],
								...(owner ? [["terminal", "Terminal", <TerminalIcon key="icon" size={20} />, 0] as const] : []),
							] as const
						).map(([id, label, icon, count]) => (
							<button
								key={id}
								type="button"
								aria-pressed={tab === id}
								aria-label={count ? `${label} (${count})` : label}
								title={label}
								onClick={() => setTab(id)}
							>
								{icon}
								{count > 0 && <span>{count}</span>}
							</button>
						))}
					</div>
					<span className="spacer workspace-location" title={shownWhere}>
						{shownWhere}
					</span>
					{!terminal && (
						<button
							type="button"
							className="icon-button"
							onClick={() => setVersion((current) => current + 1)}
							aria-label="Refresh"
							title="Refresh"
						>
							<RefreshIcon />
						</button>
					)}
					<button
						type="button"
						className="icon-button"
						onClick={() => void nav.close((current) => ({ ...current, workspace: undefined }))}
						aria-label="Close workspace"
					>
						<CloseIcon />
					</button>
				</header>
				<div className={`workspace-body ${terminal ? "terminal-body" : ""}`} ref={scroller}>
					{moveNote && !terminal && <p className="notice workspace-note">{moveNote}</p>}
					{body}
				</div>
				{comments.length > 0 && (
					<div className="review-bar">
						<span>
							{comments.length} comment{comments.length === 1 ? "" : "s"}
							{commented.size > 1 ? ` in ${commented.size} files` : ""}
						</span>
						<button
							type="button"
							className="text-action"
							onClick={() => {
								setComments([]);
								setEditor(undefined);
							}}
						>
							Discard
						</button>
						<button
							type="button"
							className="button primary"
							disabled={!onSend || sending}
							onClick={() => send(comments)}
						>
							Send all
						</button>
					</div>
				)}
			</div>
		</aside>
	);
}
