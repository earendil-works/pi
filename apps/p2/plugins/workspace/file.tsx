import { filePreview } from "@p2/app/v1";
import {
	ChevronIcon,
	CloseIcon,
	type CodeLine,
	DownIcon,
	DownloadIcon,
	LinesBlock,
	Markdown,
	patchLines,
	textLines,
} from "@p2/app/v1/web";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceResult } from "./protocol.ts";

export type FileView = "changes" | "file" | "preview";
type Diff = Extract<WorkspaceResult, { kind: "diff" }>;
type File = Extract<WorkspaceResult, { kind: "file" }>;
/** An open comment box: a new comment on a line, or an edit of an existing one. Persisted with the drafts. */
export type CommentEditor = {
	path: string;
	view: "changes" | "file";
	line: number;
	id?: string;
	text: string;
	commit?: string;
};
/** A draft review comment: the quoted lines are kept as seen, so later edits can't shift its meaning. */
export type ReviewComment = {
	id: string;
	path: string;
	view: "changes" | "file";
	start: number;
	end: number;
	quote: string;
	text: string;
	/** Set when written on a commit's version of the file rather than the working tree. */
	commit?: string;
};

function size(bytes: number): string {
	return bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One message for the agent: path, line range, the quoted lines and each comment. */
export function reviewMessage(comments: readonly ReviewComment[]): string {
	return [
		"Review comments:",
		...comments.map((comment) => {
			const range = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
			const where = `${comment.commit ? ` @${comment.commit.slice(0, 8)}` : ""}${comment.view === "changes" ? " (in the diff)" : ""}`;
			const quote = comment.quote
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
			return `\n${comment.path}:${range}${where}\n${quote}\n${comment.text.trim()}`;
		}),
	].join("\n");
}

/** Whether a comment's line no longer reads as it did when written. */
export function outdated(comment: ReviewComment, lines: readonly CodeLine[] | undefined): boolean {
	if (!lines) return false;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (line?.number === comment.end) return quoteOf(line) !== comment.quote;
	}
	return true;
}

function quoteOf(line: CodeLine): string {
	return `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}${line.text}`.slice(0, 4000);
}

// One workspace file: Changes (changed sections), File (whole file, changes inline)
// and Preview (rendered Markdown and media). Changes and File take line comments.
export function WorkspaceFile({
	path,
	view,
	views,
	diff,
	file,
	error,
	url,
	commit,
	wrap,
	comments,
	editor,
	onEditor,
	line,
	contextLines,
	onContext,
	onView,
	onWrap,
	onBack,
	closable,
	onComments,
	onSendOne,
}: {
	path: string;
	view: FileView;
	views: FileView[];
	diff?: Diff;
	file?: File;
	error?: string;
	/** Working-tree file URL for previews and download; absent for a commit's version. */
	url?: string;
	/** Viewing the file as of this commit. */
	commit?: string;
	wrap: boolean;
	comments: ReviewComment[];
	editor?: CommentEditor;
	onEditor: (editor: CommentEditor | undefined) => void;
	/** Scroll to and mark this line (from search results or tool cards). */
	line?: number;
	/** Unchanged lines shown around changes in the Changes view. */
	contextLines: number;
	onContext: (lines: number) => void;
	onView: (view: FileView) => void;
	onWrap: () => void;
	onBack: () => void;
	/** Shown beside the list it was opened from: leaving closes the file (×) rather than going back to the list. */
	closable?: boolean;
	onComments: (comments: ReviewComment[]) => void;
	/** Send one comment on its own; absent when the viewer cannot send. */
	onSendOne?: (comment: ReviewComment) => void;
}) {
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const preview = filePreview(name);

	// File view: the whole-file diff when it changed, otherwise the plain text.
	const lines = useMemo((): CodeLine[] | undefined => {
		if (view === "changes") return diff ? patchLines(diff.patch) : undefined;
		if (view !== "file") return undefined;
		if (diff?.patch && !diff.truncated) return patchLines(diff.patch, true);
		return file?.text !== undefined ? textLines(file.text) : undefined;
	}, [diff, file, view]);
	const numbered = (index: number) => lines?.[index]?.number;
	// Scroll a requested line into view once its content has rendered.
	const body = useRef<HTMLDivElement>(null);
	const target = line !== undefined ? lines?.findIndex((entry) => entry.kind !== "del" && entry.number === line) : -1;
	useEffect(() => {
		if (target === undefined || target < 0) return;
		body.current?.querySelectorAll(".diff-line")[target]?.scrollIntoView({ block: "center" });
	}, [target]);
	const commentable = view === "changes" || view === "file";
	const mine = useMemo(
		() =>
			comments
				.filter((comment) => comment.path === path && comment.view === view && comment.commit === commit)
				.toSorted((a, b) => a.end - b.end),
		[comments, path, view, commit],
	);
	const open =
		commentable && editor?.path === path && editor.view === view && editor.commit === commit ? editor : undefined;
	// A comment shows once, below the last row with its line number (a deleted and an
	// added line can share a number). Indexed once: every row asks, and a file has tens of thousands of rows.
	const lastRows = useMemo(() => {
		const rows = new Map<number, number>();
		lines?.forEach((entry, index) => {
			if (entry.number !== undefined) rows.set(entry.number, index);
		});
		return rows;
	}, [lines]);
	const rowOf = (number: number) => lastRows.get(number) ?? -1;
	const commentsAt = useMemo(() => {
		const byLine = new Map<number, typeof mine>();
		for (const comment of mine) byLine.set(comment.end, [...(byLine.get(comment.end) ?? []), comment]);
		return byLine;
	}, [mine]);
	const pick = (index: number) => {
		const number = numbered(index);
		if (!commentable || number === undefined) return;
		onEditor(
			open && !open.id && open.line === number
				? undefined
				: { path, view, line: number, text: "", ...(commit ? { commit } : {}) },
		);
	};
	const save = () => {
		if (!open || !open.text.trim() || !lines || !commentable) return;
		if (open.id) onComments(comments.map((entry) => (entry.id === open.id ? { ...entry, text: open.text } : entry)));
		else {
			const row = lines[rowOf(open.line)];
			if (!row) return;
			onComments([
				...comments,
				{
					id: crypto.randomUUID(),
					path,
					view,
					start: open.line,
					end: open.line,
					quote: quoteOf(row),
					text: open.text,
					...(commit ? { commit } : {}),
				},
			]);
		}
		onEditor(undefined);
	};
	// ↑/↓ moves between this file's comments, like search results in an IDE.
	const [current, setCurrent] = useState(-1);
	// biome-ignore lint/correctness/useExhaustiveDependencies: another file or view starts before its first comment.
	useEffect(() => setCurrent(-1), [path, view]);
	const jump = (step: number) => {
		if (!mine.length) return;
		const next = (current + step + mine.length) % mine.length;
		setCurrent(next);
		const comment = mine[next];
		if (comment) body.current?.querySelector(`[data-comment="${comment.id}"]`)?.scrollIntoView({ block: "center" });
	};
	const editorBox = (value: CommentEditor) => (
		<span className="line-comment editor">
			<textarea
				value={value.text}
				onChange={(event) => onEditor({ ...value, text: event.target.value })}
				placeholder="Comment for the agent…"
				aria-label="Comment"
				rows={2}
				// biome-ignore lint/a11y/noAutofocus: opened by an explicit tap.
				autoFocus
			/>
			<span className="line-comment-actions">
				<button type="button" className="text-action" onClick={() => onEditor(undefined)}>
					Cancel
				</button>
				<button type="button" className="text-action" disabled={!value.text.trim()} onClick={save}>
					{value.id ? "Save" : "Add comment"}
				</button>
			</span>
		</span>
	);
	const after = (index: number) => {
		const number = numbered(index);
		if (number === undefined || rowOf(number) !== index) return null;
		const here = commentsAt.get(number) ?? [];
		return (
			<>
				{here.map((comment) =>
					open?.id === comment.id ? (
						<Fragment key={comment.id}>{editorBox(open)}</Fragment>
					) : (
						<span
							key={comment.id}
							data-comment={comment.id}
							className={`line-comment ${mine[current]?.id === comment.id ? "current" : ""} ${outdated(comment, lines) ? "outdated" : ""}`}
						>
							{outdated(comment, lines) && (
								<span className="line-comment-outdated">
									Outdated: line {comment.end} was <code>{comment.quote}</code>
								</span>
							)}
							<button
								type="button"
								className="line-comment-text"
								title="Edit comment"
								onClick={() =>
									onEditor({
										path,
										view: comment.view,
										line: comment.end,
										id: comment.id,
										text: comment.text,
										...(commit ? { commit } : {}),
									})
								}
							>
								{comment.text}
							</button>
							{onSendOne && (
								<button type="button" className="text-action" onClick={() => onSendOne(comment)}>
									Send
								</button>
							)}
							<button
								type="button"
								className="icon-button"
								aria-label="Delete comment"
								onClick={() => onComments(comments.filter((entry) => entry.id !== comment.id))}
							>
								<CloseIcon />
							</button>
						</span>
					),
				)}
				{open && !open.id && open.line === number && editorBox(open)}
			</>
		);
	};

	let content: React.ReactNode;
	if (error) content = <p className="notice error workspace-note">{error}</p>;
	else if (view === "preview") {
		content =
			preview?.kind === "image" ? (
				<img className="file-media" src={url} alt={name} />
			) : preview?.kind === "audio" ? (
				// biome-ignore lint/a11y/useMediaCaption: workspace files have no caption sidecar.
				<audio className="file-media" src={url} controls preload="metadata" />
			) : preview?.kind === "video" ? (
				// biome-ignore lint/a11y/useMediaCaption: workspace files have no caption sidecar.
				<video className="file-media" src={url} controls preload="metadata" playsInline />
			) : file?.text !== undefined ? (
				<div className="workspace-markdown">
					<Markdown text={file.text} />
				</div>
			) : (
				<div className="spinner large" />
			);
		content = <div className="workspace-media">{content}</div>;
	} else if (view === "file" && file?.binary) {
		content = <p className="notice workspace-note">Binary file, {size(file.size)}. Download it to open.</p>;
	} else if (!lines) content = <div className="spinner large" />;
	else if (!lines.length || (view === "changes" && !diff?.patch))
		content = <p className="notice workspace-note">No changes.</p>;
	else
		content = (
			<>
				<LinesBlock
					lines={lines}
					language={name}
					marked={target}
					onHunk={
						view === "changes" && contextLines < 1000
							? () => onContext(contextLines < 10 ? 10 : contextLines < 25 ? 25 : 1000)
							: undefined
					}
					selected={(index) =>
						open !== undefined && !open.id && numbered(index) === open.line && rowOf(open.line) === index
					}
					onLine={commentable ? pick : undefined}
					after={after}
				/>
				{view === "changes" && diff?.truncated && <p className="notice workspace-note">Diff truncated.</p>}
				{view === "file" && diff?.truncated && (
					<p className="notice workspace-note">Too large to show changes inline.</p>
				)}
				{view === "file" && file?.truncated && (
					<p className="notice workspace-note">Showing the first 1 MiB of {size(file.size)}.</p>
				)}
			</>
		);

	return (
		<div className={`workspace-view ${wrap ? "wrap" : ""}`} ref={body}>
			<div className="workspace-bars">
				<div className="workspace-bar">
					{closable ? (
						<button type="button" className="icon-button" onClick={onBack} aria-label="Close file">
							<CloseIcon />
						</button>
					) : (
						<button type="button" className="icon-button back" onClick={onBack} aria-label="Back">
							<ChevronIcon size={18} />
						</button>
					)}
					<span className="workspace-path" title={path}>
						{slash >= 0 && <span className="muted">{path.slice(0, slash + 1)}</span>}
						{name}
					</span>
					{commit && <span className="workspace-commit mono">{commit.slice(0, 8)}</span>}
					{url && (
						<a className="icon-button" href={url} download={name} aria-label={`Download ${name}`}>
							<DownloadIcon />
						</a>
					)}
				</div>
				<div className="workspace-bar secondary">
					{views.length > 1 && (
						<span className="segments workspace-views">
							{views.map((entry) => (
								<button key={entry} type="button" aria-pressed={view === entry} onClick={() => onView(entry)}>
									{{ changes: "Changes", file: "File", preview: "Preview" }[entry]}
								</button>
							))}
						</span>
					)}
					<span className="spacer" />
					{mine.length > 0 && (
						<span className="comment-nav">
							<button
								type="button"
								className="icon-button"
								aria-label="Previous comment"
								onClick={() => jump(-1)}
							>
								<DownIcon />
							</button>
							<span>{current < 0 ? mine.length : `${current + 1}/${mine.length}`}</span>
							<button type="button" className="icon-button" aria-label="Next comment" onClick={() => jump(1)}>
								<DownIcon />
							</button>
						</span>
					)}
					{view !== "preview" && (
						<button
							type="button"
							className={`text-action ${wrap ? "on" : ""}`}
							aria-pressed={wrap}
							onClick={onWrap}
						>
							Wrap
						</button>
					)}
				</div>
			</div>
			{commentable && !comments.length && !open && lines?.length ? (
				<p className="workspace-hint">Tap line numbers to comment.</p>
			) : null}
			{content}
		</div>
	);
}
