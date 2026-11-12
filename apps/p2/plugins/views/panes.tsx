// The built-in view kinds' panes: a Markdown file of the workspace rendered, and the working tree's changes (below a
// path), both items of the view (`PaneProps.item`).
import { BACKGROUND_CONTEXT, liveIn } from "@p2/app/v1";
import {
	ChevronIcon,
	errorText,
	LinesBlock,
	Markdown,
	type PaneProps,
	patchLines,
	useObject,
	useReadable,
	useStatus,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { Workspace } from "../workspace/contract.ts";
import type { WorkspaceChange } from "../workspace/protocol.ts";
import { excerpt, usePaneSelection } from "./pane-kit.tsx";

/** A Markdown file of the workspace, rendered, and again whenever the working tree changes. */
export function MarkdownPane({ session, item, select }: PaneProps) {
	const path = item ?? "";
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
export function ChangesPane({ session, item: below, select }: PaneProps) {
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
						changes: result.changes.filter((change) => !below || change.path.startsWith(below)),
					});
			})
			.catch((error: unknown) => current && setStatus({ error: errorText(error) }));
		return () => {
			current = false;
		};
	}, [workspace, changed, below]);
	if (!workspace) return <Unavailable />;
	return (
		<div className="views-doc views-changes" ref={body}>
			{status.error ? (
				<div className="notice error">{status.error}</div>
			) : !status.changes ? (
				<div className="spinner" />
			) : !status.changes.length ? (
				<p className="empty-note">No changes{below ? ` in ${below}` : ""}.</p>
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

function Unavailable() {
	return <p className="empty-note">Only people who may send in this session see its files.</p>;
}
