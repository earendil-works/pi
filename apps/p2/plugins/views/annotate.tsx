// The annotation layer over the workbench: a toolbar to comment on selected text, mark text for removal or draw over
// any pane (the transcript included); drawings shown over their panes; and the quoted text of comments and removals
// highlighted where the panes show it (CSS custom highlights: the page's DOM stays as React made it).
import { BACKGROUND_CONTEXT, type RefIn } from "@p2/app/v1";
import { CloseIcon, CommentIcon, PencilIcon, useComposerState } from "@p2/app/v1/web";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { type Annotation, type AnnotationInput, TRANSCRIPT, type View, type Views } from "./contract.ts";
import { frameHandles, noteSelection, takeSelection } from "./kinds.ts";
import { setAnnotateMode, useAnnotateMode } from "./layout-store.ts";

type Editor = RefIn<typeof Views, "editor">;
type Point = { x: number; y: number };

/** How long after the last stroke a drawing is saved. */
const INK_PAUSE = 1200;

/** The toolbar, and while drawing, the surface strokes are drawn on. */
export function AnnotationLayer({
	container,
	annotations,
	views,
	editor,
}: {
	container: RefObject<HTMLDivElement | null>;
	annotations: readonly Annotation[];
	views: readonly View[];
	editor: Editor | undefined;
}) {
	const mode = useAnnotateMode();
	const { fail } = useComposerState();
	const [hint, setHint] = useState<string>();
	const [comment, setComment] = useState<{ view: string; quote: string }>();
	const [note, setNote] = useState("");
	const [listOpen, setListOpen] = useState(false);
	// Strokes drawn and not saved yet, and the one being drawn; `redraw` shows their changes.
	const strokes = useRef<Point[][]>([]);
	const drawing = useRef<Point[] | undefined>(undefined);
	const [, setRedraw] = useState(0);
	const redraw = () => setRedraw((count) => count + 1);
	const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// Text selected in the page's own panes; frames report theirs (CustomPane).
	useEffect(() => {
		const changed = () => {
			const selected = pageSelection(container.current);
			if (selected) noteSelection(selected.view, selected.quote);
		};
		document.addEventListener("selectionchange", changed);
		return () => document.removeEventListener("selectionchange", changed);
	}, [container]);

	const annotate = (input: AnnotationInput) => {
		if (!editor) return;
		editor.annotate(input, BACKGROUND_CONTEXT).catch(fail);
	};

	const mark = (kind: "comment" | "delete") => {
		// The page's selection as it is now (the button kept it), else the newest one a pane or frame reported.
		const reported = takeSelection();
		const selected = pageSelection(container.current) ?? reported;
		if (!selected) {
			setHint("Select text in the transcript or a view first.");
			return;
		}
		setHint(undefined);
		if (kind === "delete") annotate({ kind: "delete", view: selected.view, quote: selected.quote });
		else {
			setComment(selected);
			setNote("");
		}
	};

	const saveComment = (event: FormEvent) => {
		event.preventDefault();
		if (comment && note.trim())
			annotate({ kind: "comment", view: comment.view, quote: comment.quote, note: note.trim() });
		setComment(undefined);
	};

	const saveInk = async (drawn: Point[][]) => {
		const groups = new Map<HTMLElement, Point[][]>();
		for (const stroke of drawn) {
			const [first] = stroke;
			const pane = first && paneAt(container.current, first);
			if (pane) groups.set(pane, [...(groups.get(pane) ?? []), stroke]);
		}
		for (const [pane, group] of groups) {
			const view = pane.getAttribute("data-view-pane");
			if (!view) continue;
			const rect = pane.getBoundingClientRect();
			const box = boundsOf(group);
			const frame = frameHandles.get(view);
			const under = frame
				? await frame
						.describe({ x: box.x - rect.left, y: box.y - rect.top, width: box.width, height: box.height })
						.catch(() => "")
				: textUnder(pane, group, box);
			annotate({
				kind: "ink",
				view,
				aspect: rect.width / Math.max(1, rect.height),
				strokes: group.map((stroke) =>
					thin(stroke).flatMap((point) => [
						round((point.x - rect.left) / Math.max(1, rect.width)),
						round((point.y - rect.top) / Math.max(1, rect.height)),
					]),
				),
				...(under ? { under: under.slice(0, 4000) } : {}),
			});
		}
	};

	const flushInk = () => {
		clearTimeout(pause.current);
		const drawn = strokes.current;
		strokes.current = [];
		redraw();
		if (drawn.length) void saveInk(drawn);
	};

	// Leaving draw mode saves what was drawn.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the mode changes only.
	useEffect(() => {
		if (mode !== "draw") flushInk();
	}, [mode]);

	const origin = container.current?.getBoundingClientRect();
	const shown = drawing.current ? [...strokes.current, drawing.current] : strokes.current;
	return (
		<>
			{mode === "draw" && editor && (
				<svg
					className="views-ink-input"
					role="img"
					aria-label="Drawing surface"
					onPointerDown={(event) => {
						event.preventDefault();
						event.currentTarget.setPointerCapture(event.pointerId);
						clearTimeout(pause.current);
						drawing.current = [{ x: event.clientX, y: event.clientY }];
						redraw();
					}}
					onPointerMove={(event) => {
						if (!drawing.current) return;
						drawing.current.push({ x: event.clientX, y: event.clientY });
						redraw();
					}}
					onPointerUp={() => {
						const stroke = drawing.current;
						drawing.current = undefined;
						if (stroke && stroke.length > 1) strokes.current = [...strokes.current, stroke];
						redraw();
						clearTimeout(pause.current);
						pause.current = setTimeout(flushInk, INK_PAUSE);
					}}
				>
					{shown.map((stroke, index) => (
						<polyline
							// biome-ignore lint/suspicious/noArrayIndexKey: strokes only grow while drawn.
							key={index}
							points={stroke
								.map((point) => `${point.x - (origin?.left ?? 0)},${point.y - (origin?.top ?? 0)}`)
								.join(" ")}
						/>
					))}
				</svg>
			)}
			<div className="views-annotate-bar" role="toolbar" aria-label="Annotate">
				{editor ? (
					<>
						<button type="button" onPointerDown={keepSelection} onClick={() => mark("comment")}>
							<CommentIcon />
							<span>Comment</span>
						</button>
						<button type="button" onPointerDown={keepSelection} onClick={() => mark("delete")}>
							<span className="views-strike">abc</span>
							<span>Remove</span>
						</button>
						<button
							type="button"
							aria-pressed={mode === "draw"}
							className={mode === "draw" ? "on" : ""}
							onClick={() => setAnnotateMode(mode === "draw" ? "text" : "draw")}
						>
							<PencilIcon />
							<span>Draw</span>
						</button>
					</>
				) : (
					<span className="muted">Only people who may send here annotate.</span>
				)}
				<button type="button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
					<span>Notes {annotations.length ? `(${annotations.length})` : ""}</span>
				</button>
				<button type="button" onClick={() => setAnnotateMode("off")}>
					<span>Done</span>
				</button>
				{hint && <p className="views-annotate-hint">{hint}</p>}
				{comment && (
					<form className="views-comment" onSubmit={saveComment}>
						<p className="muted">On {excerpt(comment.quote)}</p>
						<textarea
							// biome-ignore lint/a11y/noAutofocus: the comment box opens for typing.
							autoFocus
							value={note}
							placeholder="Comment"
							rows={2}
							onChange={(event) => setNote(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) saveComment(event);
								if (event.key === "Escape") setComment(undefined);
							}}
						/>
						<div className="views-comment-actions">
							<button type="button" className="text-action" onClick={() => setComment(undefined)}>
								Cancel
							</button>
							<button type="submit" className="text-action" disabled={!note.trim()}>
								Save
							</button>
						</div>
					</form>
				)}
				{listOpen && <NotesList annotations={annotations} views={views} editor={editor} />}
			</div>
		</>
	);
}

/** The annotations, newest last, with what they mark; editors remove them one by one or all. */
function NotesList({
	annotations,
	views,
	editor,
}: {
	annotations: readonly Annotation[];
	views: readonly View[];
	editor: Editor | undefined;
}) {
	const { fail } = useComposerState();
	const remove = (ids?: string[]) => editor?.unannotate(ids ? { ids } : {}, BACKGROUND_CONTEXT).catch(fail);
	if (!annotations.length) return <p className="views-notes empty-note">No annotations.</p>;
	return (
		<div className="views-notes">
			<ul>
				{annotations.map((annotation) => (
					<li key={annotation.id}>
						<div>
							<strong>{KIND_WORDS[annotation.kind]}</strong>{" "}
							<span className="muted">
								{annotation.view === TRANSCRIPT
									? "Chat"
									: (views.find((view) => view.id === annotation.view)?.title ?? annotation.view)}
								{annotation.sent ? " · sent" : ""}
							</span>
							{(annotation.quote || annotation.under || annotation.note) && (
								<p>
									{annotation.quote || annotation.under
										? excerpt(annotation.quote ?? annotation.under ?? "")
										: ""}
									{annotation.note ? ` — ${annotation.note}` : ""}
								</p>
							)}
						</div>
						{editor && (
							<button
								type="button"
								className="icon-button"
								aria-label="Remove note"
								onClick={() => remove([annotation.id])}
							>
								<CloseIcon />
							</button>
						)}
					</li>
				))}
			</ul>
			{editor && (
				<button type="button" className="text-action" onClick={() => remove()}>
					Clear all
				</button>
			)}
		</div>
	);
}

const KIND_WORDS: Record<Annotation["kind"], string> = { comment: "Comment", delete: "Remove", ink: "Drawing" };

/** A pane's drawings, over it (they stretch with the pane). */
export function InkLayer({ annotations }: { annotations: readonly Annotation[] }) {
	const inks = annotations.filter((annotation) => annotation.kind === "ink" && annotation.strokes?.length);
	if (!inks.length) return null;
	return (
		<svg className="views-ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
			{inks.flatMap((annotation) =>
				(annotation.strokes ?? []).map((stroke, index) => (
					<polyline
						key={`${annotation.id}:${index}`}
						className={annotation.sent ? "sent" : ""}
						points={pairs(stroke)}
						vectorEffect="non-scaling-stroke"
					/>
				)),
			)}
		</svg>
	);
}

/**
 * Highlights the quotes of comments and removals in the page's panes (frames highlight their own), again whenever the
 * panes' text changes.
 */
export function useNoteHighlights(
	container: RefObject<HTMLDivElement | null>,
	annotations: readonly Annotation[],
): void {
	useEffect(() => {
		const element = container.current;
		const quoted = annotations.filter((annotation) => annotation.quote && annotation.kind !== "ink");
		if (!element || !CSS.highlights || typeof Highlight !== "function") return;
		const run = () => {
			const notes = new Highlight();
			const deletes = new Highlight();
			for (const pane of element.querySelectorAll<HTMLElement>("[data-view-pane]")) {
				const view = pane.getAttribute("data-view-pane");
				const own = quoted.filter((annotation) => annotation.view === view);
				if (!own.length || frameHandles.has(view ?? "")) continue;
				const text = textMap(pane);
				for (const annotation of own) {
					const range = findRange(text, annotation.quote ?? "");
					if (range) (annotation.kind === "delete" ? deletes : notes).add(range);
				}
			}
			CSS.highlights.set("p2-note", notes);
			CSS.highlights.set("p2-note-delete", deletes);
		};
		run();
		if (!quoted.length) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new MutationObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(run, 300);
		});
		observer.observe(element, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			clearTimeout(timer);
		};
	}, [container, annotations]);
	useEffect(
		() => () => {
			CSS.highlights?.delete("p2-note");
			CSS.highlights?.delete("p2-note-delete");
		},
		[],
	);
}

/** A pane's text with runs of whitespace as one space, and where each character of it is. */
type TextMap = { text: string; at: { node: Text; offset: number }[] };

function textMap(root: HTMLElement): TextMap {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let text = "";
	const at: TextMap["at"] = [];
	let space = true;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!(node instanceof Text)) continue;
		const data = node.data;
		for (let offset = 0; offset < data.length; offset++) {
			const white = /\s/.test(data[offset] ?? "");
			if (white && space) continue;
			text += white ? " " : data[offset];
			at.push({ node, offset });
			space = white;
		}
	}
	return { text, at };
}

function findRange(map: TextMap, quote: string): Range | undefined {
	const needle = quote.replace(/\s+/g, " ").trim();
	const index = needle ? map.text.indexOf(needle) : -1;
	const start = map.at[index];
	const end = map.at[index + needle.length - 1];
	if (index < 0 || !start || !end) return undefined;
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset + 1);
	return range;
}

/** The page's text selection when it lies in a pane of `container`. */
function pageSelection(container: HTMLDivElement | null): { view: string; quote: string } | undefined {
	const selection = getSelection();
	if (!selection?.rangeCount || selection.isCollapsed) return undefined;
	const node = selection.getRangeAt(0).commonAncestorContainer;
	const element = node instanceof Element ? node : node.parentElement;
	const pane = element?.closest("[data-view-pane]");
	const view = pane?.getAttribute("data-view-pane");
	const quote = selection.toString().trim().slice(0, 4000);
	return view && quote && container?.contains(pane ?? null) ? { view, quote } : undefined;
}

/** The pane under a point of the page. */
function paneAt(container: HTMLDivElement | null, point: Point): HTMLElement | undefined {
	for (const pane of container?.querySelectorAll<HTMLElement>("[data-view-pane]") ?? []) {
		if (pane.hidden) continue;
		const rect = pane.getBoundingClientRect();
		if (point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom) return pane;
	}
	return undefined;
}

function boundsOf(strokes: Point[][]): { x: number; y: number; width: number; height: number } {
	const points = strokes.flat();
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The texts of the innermost elements of `pane` under the strokes and inside their bounds. */
function textUnder(
	pane: HTMLElement,
	strokes: Point[][],
	box: { x: number; y: number; width: number; height: number },
): string {
	const points = [...strokes.flat().filter((_, index) => index % 4 === 0)];
	for (let i = 0; i <= 4; i++)
		for (let j = 0; j <= 4; j++) points.push({ x: box.x + (box.width * i) / 4, y: box.y + (box.height * j) / 4 });
	const found: Element[] = [];
	for (const point of points) {
		const element = document
			.elementsFromPoint(point.x, point.y)
			.find((each) => pane.contains(each) && each !== pane && !each.closest(".views-ink"));
		if (element && !found.includes(element)) found.push(element);
	}
	const texts: string[] = [];
	for (const element of found.filter((each) => !found.some((other) => other !== each && each.contains(other)))) {
		const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
		if (text && !texts.includes(text)) texts.push(text);
	}
	return texts.join(" · ");
}

/** Every other point of a long stroke: enough for its shape, half the size. */
const thin = (stroke: Point[]) => (stroke.length > 200 ? stroke.filter((_, index) => index % 2 === 0) : stroke);
const round = (value: number) => Math.round(value * 10000) / 10000;
const pairs = (stroke: readonly number[]) => {
	const points: string[] = [];
	for (let i = 0; i + 1 < stroke.length; i += 2) points.push(`${stroke[i]},${stroke[i + 1]}`);
	return points.join(" ");
};
const excerpt = (text: string) => {
	const line = text.replace(/\s+/g, " ").trim();
	return `“${line.length > 120 ? `${line.slice(0, 120)}…` : line}”`;
};
/** Buttons pressed while text is selected keep the selection (a press would collapse it first). */
const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();
