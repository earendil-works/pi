// The built-in view kinds' panes: a Markdown file of the workspace rendered, the working tree's changes, and a custom
// view's sandboxed frame with its side of the bridge (bridge.ts).
import { BACKGROUND_CONTEXT, type JsonValue, liveIn } from "@p2/app/v1";
import {
	ChevronIcon,
	errorText,
	LinesBlock,
	Markdown,
	patchLines,
	useComposerState,
	useObject,
	useReadable,
	useStatus,
} from "@p2/app/v1/web";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Workspace } from "../workspace/contract.ts";
import type { WorkspaceChange } from "../workspace/protocol.ts";
import { VIEW_CHANNEL } from "./bridge.ts";
import { MAX_VIEW_STATE, ViewState, Views } from "./contract.ts";
import { frameHandles, noteSelection, type PaneProps } from "./kinds.ts";
import { annotateMode } from "./layout-store.ts";

/** How long a selection rests before it is reported (a drag selects many times). */
const SELECTION_PAUSE = 600;
/** How long a frame's state rests before it is saved. */
const STATE_PAUSE = 300;

/** A Markdown file of the workspace, rendered, and again whenever the working tree changes. */
export function MarkdownPane({ session, view, select }: PaneProps) {
	const path = view.path ?? "";
	const text = useWorkspaceText(session, path);
	const body = useRef<HTMLDivElement>(null);
	usePaneSelection(
		body,
		(quote) => ({ summary: `${excerpt(quote)} in ${path}`, data: { text: quote, path } }),
		select,
	);
	return (
		<div className="views-doc" ref={body}>
			{text.error ? (
				<div className="notice error">{text.error}</div>
			) : text.value === undefined ? (
				<div className="spinner" />
			) : (
				<Markdown text={text.value} />
			)}
		</div>
	);
}

/** The working tree's changes (below the view's path), each file's diff below its name. */
export function ChangesPane({ session, view, select }: PaneProps) {
	const workspace = useWorkspace(session);
	const changed = useReadable(workspace?.changes);
	const [status, setStatus] = useState<{ changes?: WorkspaceChange[]; error?: string }>({});
	const body = useRef<HTMLDivElement>(null);
	usePaneSelection(
		body,
		(quote, element) => {
			const path = element?.closest("[data-path]")?.getAttribute("data-path") ?? undefined;
			return {
				summary: `${excerpt(quote)} in the diff${path ? ` of ${path}` : ""}`,
				data: { text: quote, ...(path ? { path } : {}) },
			};
		},
		select,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` counts the working tree's changes: load again.
	useEffect(() => {
		if (!workspace) return;
		let current = true;
		workspace
			.query({ kind: "status" }, BACKGROUND_CONTEXT)
			.then((result) => {
				if (!current || result.kind !== "status") return;
				if (!result.repo) setStatus({ error: result.reason ?? "Not a git repository" });
				else
					setStatus({
						changes: result.changes.filter((change) => !view.path || change.path.startsWith(view.path)),
					});
			})
			.catch((error: unknown) => current && setStatus({ error: errorText(error) }));
		return () => {
			current = false;
		};
	}, [workspace, changed, view.path]);
	if (!workspace) return <Unavailable />;
	return (
		<div className="views-doc views-changes" ref={body}>
			{status.error ? (
				<div className="notice error">{status.error}</div>
			) : !status.changes ? (
				<div className="spinner" />
			) : !status.changes.length ? (
				<p className="empty-note">No changes{view.path ? ` in ${view.path}` : ""}.</p>
			) : (
				status.changes.map((change) => (
					<ChangedFile
						key={change.path}
						session={session}
						change={change}
						open={(status.changes?.length ?? 0) <= 12}
						changed={changed ?? 0}
					/>
				))
			)}
		</div>
	);
}

function ChangedFile({
	session,
	change,
	open: initiallyOpen,
	changed,
}: {
	session: string;
	change: WorkspaceChange;
	open: boolean;
	changed: number;
}) {
	const workspace = useWorkspace(session);
	const [open, setOpen] = useState(initiallyOpen);
	const [patch, setPatch] = useState<{ value?: string; error?: string }>({});
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` counts the working tree's changes: load again.
	useEffect(() => {
		if (!workspace || !open) return;
		let current = true;
		workspace
			.query({ kind: "diff", path: change.path, context: 3 }, BACKGROUND_CONTEXT)
			.then((result) => current && result.kind === "diff" && setPatch({ value: result.patch }))
			.catch((error: unknown) => current && setPatch({ error: errorText(error) }));
		return () => {
			current = false;
		};
	}, [workspace, open, change.path, changed]);
	return (
		<section className="views-change" data-path={change.path}>
			<button type="button" className="views-change-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className={`views-chevron ${open ? "open" : ""}`}>
					<ChevronIcon size={14} />
				</span>
				<span className="views-change-path">{change.path}</span>
				<span className="muted">{change.status === "??" ? "new" : change.status.replaceAll(".", "")}</span>
			</button>
			{open &&
				(patch.error ? (
					<div className="notice error">{patch.error}</div>
				) : patch.value === undefined ? (
					<div className="spinner" />
				) : patch.value ? (
					<LinesBlock lines={patchLines(patch.value)} language={change.path} />
				) : (
					<p className="empty-note">No text changes.</p>
				))}
		</section>
	);
}

/** A message a frame posted (untrusted: the view's own script can post anything). */
const isMessage = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** A custom view: its HTML in a sandboxed frame, its state and selection through the bridge. */
export function CustomPane({ session, view, editable, select, annotations }: PaneProps) {
	const frame = useRef<HTMLIFrameElement>(null);
	const state = useObject(ViewState, { session, view: view.id });
	useStatus(state);
	const value = useReadable(state?.value);
	const writer = liveIn(state, "editor");
	const viewsRef = useObject(Views, { session });
	useStatus(viewsRef);
	const views = liveIn(viewsRef, "editor");
	const { fail } = useComposerState();
	/** The JSON the frame last saved: coming back from the worker, it is not sent to the frame again. */
	const own = useRef<string | undefined>(undefined);
	const ready = useRef(false);
	const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; value?: JsonValue }>({});
	const regions = useRef(new Map<string, (text: string) => void>());
	const lastSelection = useRef("");
	const errors = useRef<{ list: string[]; timer?: ReturnType<typeof setTimeout> }>({ list: [] });

	const post = useCallback((message: Record<string, unknown>) => {
		frame.current?.contentWindow?.postMessage({ channel: VIEW_CHANNEL, ...message }, "*");
	}, []);
	const quotes = annotations
		.filter((annotation) => annotation.quote && annotation.kind !== "ink")
		.map((annotation) => ({ text: annotation.quote, kind: annotation.kind }));
	const quotesJson = JSON.stringify(quotes);

	const sendState = useCallback(
		(from: "init" | "update") => {
			if (value === undefined) return;
			post({ type: "state", state: value, from, readOnly: !editable || !writer });
		},
		[post, value, editable, writer],
	);

	// The worker's state reaches the frame, unless it is what the frame saved itself.
	useEffect(() => {
		if (!ready.current || value === undefined) return;
		if (JSON.stringify(value) === own.current) return;
		sendState("update");
	}, [value, sendState]);

	useEffect(() => {
		if (ready.current) post({ type: "highlight", quotes: JSON.parse(quotesJson) });
	}, [quotesJson, post]);

	useEffect(() => {
		frameHandles.set(view.id, {
			selection: () => lastSelection.current,
			describe: (rect) =>
				new Promise((resolve) => {
					const id = crypto.randomUUID();
					const timer = setTimeout(() => {
						regions.current.delete(id);
						resolve("");
					}, 800);
					regions.current.set(id, (text) => {
						clearTimeout(timer);
						resolve(text);
					});
					post({ type: "describe", id, rect });
				}),
		});
		return () => {
			frameHandles.delete(view.id);
		};
	}, [view.id, post]);

	useEffect(() => {
		const save = () => {
			const next = pending.current.value;
			pending.current = {};
			if (next === undefined || !writer) return;
			writer.set({ value: next }, BACKGROUND_CONTEXT).catch(fail);
		};
		const receive = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const message: unknown = event.data;
			if (!isMessage(message)) return;
			if (message.channel === "p2-artifact-diagnostic") {
				if (message.level !== "error") return;
				const text = typeof message.message === "string" ? message.message.slice(0, 1000) : "";
				errors.current.list = [...errors.current.list.slice(-9), text];
				clearTimeout(errors.current.timer);
				errors.current.timer = setTimeout(
					() => views?.report({ id: view.id, errors: errors.current.list }, BACKGROUND_CONTEXT).catch(fail),
					1500,
				);
				return;
			}
			if (message.channel !== VIEW_CHANNEL) return;
			switch (message.type) {
				case "hello":
					ready.current = true;
					errors.current.list = [];
					sendState("init");
					post({ type: "highlight", quotes: JSON.parse(quotesJson) });
					break;
				case "set-state": {
					if (!editable || !writer) return;
					const next = (message.state ?? null) as JsonValue;
					const json = JSON.stringify(next);
					if (json.length > MAX_VIEW_STATE) {
						fail(new Error(`The view's state is over ${MAX_VIEW_STATE / 1024} KiB of JSON and was not saved`));
						return;
					}
					own.current = json;
					pending.current.value = next;
					clearTimeout(pending.current.timer);
					pending.current.timer = setTimeout(save, STATE_PAUSE);
					break;
				}
				case "select": {
					if (!editable) return;
					const summary = typeof message.summary === "string" ? message.summary.trim().slice(0, 2000) : "";
					select(summary ? { summary, data: (message.data ?? null) as JsonValue } : null);
					break;
				}
				case "text-selection": {
					const text = typeof message.text === "string" ? message.text.slice(0, 4000) : "";
					lastSelection.current = text;
					noteSelection(view.id, text);
					break;
				}
				case "region": {
					const id = typeof message.id === "string" ? message.id : "";
					regions.current.get(id)?.(typeof message.text === "string" ? message.text : "");
					regions.current.delete(id);
					break;
				}
			}
		};
		window.addEventListener("message", receive);
		return () => {
			window.removeEventListener("message", receive);
			// What the frame changed last is saved, not lost with the pane.
			if (pending.current.timer) {
				clearTimeout(pending.current.timer);
				save();
			}
		};
	}, [view.id, editable, writer, views, select, sendState, post, quotesJson, fail]);

	// A new version is a new page: it says hello again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs for each version of the page.
	useEffect(() => {
		ready.current = false;
	}, [view.source]);

	if (!view.source) return <p className="empty-note">This view has no page yet.</p>;
	const url = `/view-frame?${new URLSearchParams({ session, view: view.id, version: String(view.source) })}`;
	return (
		<iframe
			// A new frame per version: changing a frame's src would add a history entry.
			key={url}
			ref={frame}
			className="views-frame"
			title={view.title}
			src={url}
			sandbox="allow-scripts allow-modals allow-pointer-lock"
			referrerPolicy="no-referrer"
		/>
	);
}

/** The session's workspace (main conversation), for people who may write there; undefined for others. */
function useWorkspace(session: string) {
	const workspace = useObject(Workspace, { session, conversation: 1 });
	useStatus(workspace);
	return liveIn(workspace, "reader");
}

/** A workspace file's text, loaded again when the working tree changes. */
function useWorkspaceText(session: string, path: string): { value?: string; error?: string } {
	const workspace = useWorkspace(session);
	const changed = useReadable(workspace?.changes);
	const [text, setText] = useState<{ path: string; value?: string; error?: string }>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` counts the working tree's changes: load again.
	useEffect(() => {
		if (!workspace || !path) return;
		let current = true;
		workspace
			.query({ kind: "file", path }, BACKGROUND_CONTEXT)
			.then((result) => {
				if (!current || result.kind !== "file") return;
				setText(
					result.binary
						? { path, error: `${path} is not a text file` }
						: { path, value: `${result.text ?? ""}${result.truncated ? "\n\n…" : ""}` },
				);
			})
			.catch((error: unknown) => current && setText({ path, error: errorText(error) }));
		return () => {
			current = false;
		};
	}, [workspace, path, changed]);
	if (!workspace) return { error: "Only people who may send in this session see its files." };
	return text?.path === path ? text : {};
}

/**
 * Reports the person's text selection inside `body`, described by `describe`, after it rests; not while they annotate
 * (that selection is what a comment or removal quotes).
 */
function usePaneSelection(
	body: RefObject<HTMLElement | null>,
	describe: (quote: string, element: Element | null) => { summary: string; data: JsonValue },
	select: PaneProps["select"],
): void {
	const latest = useRef({ describe, select });
	latest.current = { describe, select };
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reported = "";
		const changed = () => {
			const selection = getSelection();
			if (annotateMode() !== "off" || !selection?.rangeCount || selection.isCollapsed) return;
			const node = selection.getRangeAt(0).commonAncestorContainer;
			const element = node instanceof Element ? node : node.parentElement;
			if (!body.current?.contains(element)) return;
			const quote = selection.toString().trim().slice(0, 4000);
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (!quote || quote === reported) return;
				reported = quote;
				latest.current.select(latest.current.describe(quote, element));
			}, SELECTION_PAUSE);
		};
		document.addEventListener("selectionchange", changed);
		return () => {
			document.removeEventListener("selectionchange", changed);
			clearTimeout(timer);
		};
	}, [body]);
}

function Unavailable() {
	return <p className="empty-note">Only people who may send in this session see its files.</p>;
}

const excerpt = (text: string) => {
	const line = text.replace(/\s+/g, " ").trim();
	return `“${line.length > 300 ? `${line.slice(0, 300)}…` : line}”`;
};
