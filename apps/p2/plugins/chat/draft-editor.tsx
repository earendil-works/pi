// The composer's editor: the draft as text, with its files as pills where their references sit. The draft stays a
// string (`![name](attachment:<key>)` per file, src/runtime/references.ts); the editor renders it into a
// contenteditable element and reads typing back from it in the same render, so the caret and a phone keyboard's
// composition are never disturbed. Placing, moving and removing a pill rewrites the draft, and the editor renders the
// new draft; its own history undoes both kinds of change (draft-history.ts).

import { type FileReference, referenceParts } from "@p2/app/v1";
import { type DraftInput, type PickedFile, pickedReference } from "@p2/app/v1/web";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type ChangeKind, DraftHistory } from "./draft-history.ts";

/** What the composer gives its editor: the draft, its files and the composer's key and focus handlers. */
export type DraftEditorProps = {
	readonly draft: string;
	readonly setDraft: (text: string) => void;
	readonly files: readonly PickedFile[];
	/** The input for the page (focus, files from a drop) and for completion. */
	readonly register: (input: DraftInput | null) => void;
	readonly inputRef?: RefObject<DraftInput | null>;
	readonly placeholder: string;
	/** Keys the editor does not handle itself (send, completion, stop). */
	readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	/** After the text or the caret changed (completion follows the token at the caret). */
	readonly onEdit: () => void;
	readonly onPaste: (event: ClipboardEvent<HTMLElement>) => void;
	readonly onFocus: () => void;
	readonly onBlur: () => void;
	readonly onCompositionStart: () => void;
	readonly onCompositionEnd: () => void;
};

/** A pill's menu: which file, where it shows (relative to the editor's box). */
type PillMenu = { readonly key: string; readonly left: number; readonly bottom: number };

/** The draft's editor with pills; see the file comment. */
export function DraftEditor(props: DraftEditorProps) {
	const { draft, setDraft, files, register, inputRef } = props;
	const ref = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const byKey = useMemo(() => new Map(files.map((file) => [file.key, file])), [files]);
	const history = useRef<DraftHistory>(undefined);
	history.current ??= new DraftHistory({ text: draft, caret: draft.length });
	// The caret a rewrite of the draft puts in place, and the caret before it (where its undo returns).
	const pending = useRef<{ caret: number; before: number } | undefined>(undefined);
	// A draft set by undo or redo is not a new step.
	const restoring = useRef(false);
	const composing = useRef(false);
	const typedFrom = useRef<number | undefined>(undefined);
	const lastCaret = useRef<number | undefined>(undefined);
	const drag = useRef<Drag | undefined>(undefined);
	const [menu, setMenu] = useState<PillMenu>();

	/** Puts `text` in the draft with the caret at `caret`: the render below shows it and records the step. */
	const rewrite = (text: string, caret: number, before: number) => {
		pending.current = { caret, before };
		setDraft(text);
	};
	const caretNow = (editor: HTMLElement) => caretIn(editor, lastCaret.current);
	const step = (target: { text: string; caret: number } | undefined) => {
		const editor = ref.current;
		if (!target || !editor) return;
		setMenu(undefined);
		if (target.text === serialize(editor)) {
			select(editor, target.caret, target.caret);
			return;
		}
		restoring.current = true;
		pending.current = { caret: target.caret, before: target.caret };
		setDraft(target.text);
	};
	const undo = () => step(history.current?.undo());
	const redo = () => step(history.current?.redo());

	const insertFiles = (picked: readonly PickedFile[], at?: { readonly x: number; readonly y: number }) => {
		const editor = ref.current;
		if (!editor) return;
		const text = serialize(editor);
		const offset = (at && offsetAtPoint(editor, at.x, at.y)) ?? caretNow(editor);
		const inserted = picked.map(pickedReference).join("");
		rewrite(text.slice(0, offset) + inserted + text.slice(offset), offset + inserted.length, offset);
	};
	const insert = useRef(insertFiles);
	insert.current = insertFiles;
	const input = useMemo<DraftInput>(
		() => ({
			get value() {
				return ref.current ? serialize(ref.current) : "";
			},
			get selectionStart() {
				return ref.current ? caretIn(ref.current, lastCaret.current) : 0;
			},
			setSelectionRange: (start, end) => {
				if (ref.current) select(ref.current, start, end);
			},
			focus: () => ref.current?.focus(),
			insertFiles: (picked, at) => insert.current(picked, at),
		}),
		[],
	);
	useLayoutEffect(() => {
		register(input);
		if (inputRef) inputRef.current = input;
		return () => {
			register(null);
			if (inputRef) inputRef.current = null;
		};
	}, [register, input, inputRef]);

	// The draft changed elsewhere (a rewrite, undo, restored text, a completion, a send) or its files did: render it.
	useLayoutEffect(() => {
		const editor = ref.current;
		if (!editor) return;
		const shown = serialize(editor);
		if (shown === draft && !pillsStale(editor, byKey)) return;
		const set = pending.current;
		pending.current = undefined;
		const keep = shown === draft ? selectionOffsets(editor) : undefined;
		const before = set?.before ?? lastCaret.current ?? shown.length;
		render(editor, draft, byKey);
		const caret = set?.caret ?? keep?.start ?? draft.length;
		if (set || document.activeElement === editor) select(editor, caret, keep?.end ?? caret);
		if (shown === draft) return;
		if (restoring.current) restoring.current = false;
		// Emptied from outside: sent (its files went with it) or cleared; nothing before it can come back.
		else if (draft === "") history.current = new DraftHistory({ text: "", caret: 0 });
		else history.current?.record({ text: draft, caret }, "edit", before);
		lastCaret.current = caret;
	}, [draft, byKey]);

	// The pill menu follows its pill through re-renders, and goes with it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: placed again after every render of the draft.
	useLayoutEffect(() => {
		if (!menu || !ref.current || !box.current) return;
		const pill = pillOf(ref.current, menu.key);
		if (!pill) setMenu(undefined);
		else {
			const placed = menuPlace(box.current, pill, menu.key);
			if (placed.left !== menu.left || placed.bottom !== menu.bottom) setMenu(placed);
		}
	}, [draft, menu]);

	// The browser's own undo (Edit menu, iOS shake, three-finger swipe) comes as `beforeinput`; it never runs. Each
	// other edit notes the caret before it, where its undo returns.
	useEffect(() => {
		const editor = ref.current;
		if (!editor) return;
		const before = (event: InputEvent) => {
			if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
				event.preventDefault();
				if (event.inputType === "historyUndo") undo();
				else redo();
				return;
			}
			if (!composing.current) typedFrom.current = selectionOffsets(editor)?.start;
		};
		const moved = () => {
			const offsets = selectionOffsets(editor);
			if (offsets) lastCaret.current = offsets.start;
		};
		// A textarea keeps its caret while it has no focus; a contenteditable element gets it at its start when focused
		// from code (a closing menu gives the focus back): it goes back where it was. A press sets its own caret after
		// this. Natively: a focus given back in another component's effect cleanup reaches no React handler.
		const focused = () => {
			if (lastCaret.current !== undefined) select(editor, lastCaret.current, lastCaret.current);
		};
		editor.addEventListener("beforeinput", before);
		editor.addEventListener("focus", focused);
		document.addEventListener("selectionchange", moved);
		return () => {
			editor.removeEventListener("beforeinput", before);
			editor.removeEventListener("focus", focused);
			document.removeEventListener("selectionchange", moved);
		};
	});

	// A press outside the menu and its pill closes the menu.
	useEffect(() => {
		if (!menu) return;
		const close = (event: globalThis.PointerEvent) => {
			const target = event.target as Element;
			if (!target.closest?.(".draft-pill-menu, .draft-pill")) setMenu(undefined);
		};
		document.addEventListener("pointerdown", close, { capture: true });
		return () => document.removeEventListener("pointerdown", close, { capture: true });
	}, [menu]);

	/** Reads the typed text back into the draft in the same render, and records the step once composition ends. */
	const typed = (kind: ChangeKind) => {
		const editor = ref.current;
		if (!editor) return;
		if (!composing.current) tidy(editor);
		const text = serialize(editor);
		const caret = caretNow(editor);
		if (!composing.current) {
			history.current?.record({ text, caret }, kind, typedFrom.current ?? caret);
			typedFrom.current = undefined;
		}
		setDraft(text);
		props.onEdit();
	};

	const removePill = (pill: HTMLElement) => {
		const editor = ref.current;
		if (!editor) return;
		const text = serialize(editor);
		const start = pillStart(editor, pill);
		const token = pill.dataset.token ?? "";
		rewrite(text.slice(0, start) + text.slice(start + token.length), start, caretNow(editor));
	};

	/** Swaps the menu's pill with the one before (-1) or after (1): the files trade places, the words stay. */
	const swap = (key: string, direction: -1 | 1) => {
		const editor = ref.current;
		if (!editor) return;
		const pills = [...editor.querySelectorAll<HTMLElement>(".draft-pill")];
		const index = pills.findIndex((pill) => pill.dataset.key === key);
		const other = pills[index + direction];
		const pill = pills[index];
		if (!pill || !other) return;
		const [first, second] = direction < 0 ? [other, pill] : [pill, other];
		const text = serialize(editor);
		const a = pillStart(editor, first);
		const b = pillStart(editor, second);
		const tokenA = first.dataset.token ?? "";
		const tokenB = second.dataset.token ?? "";
		const swapped =
			text.slice(0, a) + tokenB + text.slice(a + tokenA.length, b) + tokenA + text.slice(b + tokenB.length);
		// The caret goes after the menu's pill at its new place.
		rewrite(swapped, direction < 0 ? a + tokenB.length : b + tokenB.length, caretNow(editor));
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const editor = ref.current;
		if (!editor) return;
		const key = event.key.toLowerCase();
		const mod = event.metaKey || event.ctrlKey;
		if (mod && !event.altKey && key === "z") {
			event.preventDefault();
			if (event.shiftKey) redo();
			else undo();
			return;
		}
		if (event.ctrlKey && !event.metaKey && !event.altKey && key === "y") {
			event.preventDefault();
			redo();
			return;
		}
		if ((event.key === "Backspace" || event.key === "Delete") && !event.nativeEvent.isComposing) {
			const pill = adjacentPill(editor, event.key === "Backspace" ? -1 : 1);
			if (pill) {
				event.preventDefault();
				removePill(pill);
				return;
			}
		}
		if (event.key === "Escape" && menu) {
			event.preventDefault();
			setMenu(undefined);
			return;
		}
		props.onKeyDown(event);
	};

	// A pill moves with the pointer after a few pixels (touch too: pills take no scroll); a press without moving opens
	// its menu. The editor's DOM stays as it is during the drag; the drop rewrites the draft.
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const editor = ref.current;
		const pill = (event.target as Element).closest<HTMLElement>(".draft-pill");
		if (!editor || !pill || event.button !== 0) return;
		event.preventDefault();
		editor.setPointerCapture(event.pointerId);
		drag.current = { pill, x: event.clientX, y: event.clientY, moving: undefined };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const editor = ref.current;
		const current = drag.current;
		if (!editor || !current) return;
		if (!current.moving) {
			if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
			setMenu(undefined);
			current.pill.classList.add("dragging");
			const ghost = current.pill.cloneNode(true) as HTMLElement;
			ghost.classList.remove("dragging");
			ghost.classList.add("draft-pill-ghost");
			const caret = document.createElement("div");
			caret.className = "draft-drop-caret";
			document.body.append(ghost, caret);
			current.moving = { ghost, caret, offset: undefined };
		}
		const { ghost, caret } = current.moving;
		ghost.style.left = `${event.clientX}px`;
		ghost.style.top = `${event.clientY}px`;
		const bounds = editor.getBoundingClientRect();
		if (event.clientY < bounds.top + 12) editor.scrollTop -= 8;
		if (event.clientY > bounds.bottom - 12) editor.scrollTop += 8;
		const near =
			event.clientX > bounds.left - 32 &&
			event.clientX < bounds.right + 32 &&
			event.clientY > bounds.top - 32 &&
			event.clientY < bounds.bottom + 32;
		const offset = near
			? offsetAtPoint(
					editor,
					Math.min(Math.max(event.clientX, bounds.left + 1), bounds.right - 1),
					Math.min(Math.max(event.clientY, bounds.top + 1), bounds.bottom - 1),
				)
			: undefined;
		current.moving.offset = offset;
		const rect = offset === undefined ? undefined : caretRect(editor, offset);
		caret.hidden = rect === undefined;
		if (rect) {
			caret.style.left = `${rect.left - 1}px`;
			caret.style.top = `${rect.top}px`;
			caret.style.height = `${rect.height}px`;
		}
	};
	const endDrag = (drop: boolean) => {
		const editor = ref.current;
		const current = drag.current;
		drag.current = undefined;
		if (!editor || !current) return;
		const { pill, moving } = current;
		if (!moving) {
			if (drop && box.current) {
				const key = pill.dataset.key ?? "";
				setMenu((open) => (open?.key === key ? undefined : menuPlace(box.current!, pill, key)));
			}
			return;
		}
		moving.ghost.remove();
		moving.caret.remove();
		pill.classList.remove("dragging");
		if (!drop || moving.offset === undefined) return;
		const text = serialize(editor);
		const start = pillStart(editor, pill);
		const token = pill.dataset.token ?? "";
		const target = moving.offset;
		if (target >= start && target <= start + token.length) return;
		const without = text.slice(0, start) + text.slice(start + token.length);
		const at = target > start ? target - token.length : target;
		editor.focus();
		rewrite(without.slice(0, at) + token + without.slice(at), at + token.length, caretNow(editor));
	};

	const menuFile = menu ? byKey.get(menu.key) : undefined;
	const menuIndex = menu && ref.current ? pillIndex(ref.current, menu.key) : { index: -1, count: 0 };
	return (
		<div className="draft-editor-box" ref={box}>
			{/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold the pills; this is its editable stand-in. */}
			<div
				ref={ref}
				className="draft-editor"
				contentEditable="plaintext-only"
				suppressContentEditableWarning
				tabIndex={0}
				role="textbox"
				aria-multiline="true"
				aria-label="Message"
				data-placeholder={props.placeholder}
				onInput={(event) => {
					// A synthetic `input` (not an InputEvent) says nothing about what changed.
					const native = event.nativeEvent;
					const kind = native instanceof InputEvent ? native.inputType : "";
					typed(kind === "insertText" ? "insert" : kind.startsWith("deleteContent") ? "delete" : "edit");
				}}
				onKeyDown={onKeyDown}
				onClick={props.onEdit}
				onPaste={props.onPaste}
				onFocus={props.onFocus}
				onBlur={props.onBlur}
				onCompositionStart={() => {
					composing.current = true;
					typedFrom.current = ref.current ? selectionOffsets(ref.current)?.start : undefined;
					props.onCompositionStart();
				}}
				onCompositionEnd={() => {
					composing.current = false;
					typed("insert");
					props.onCompositionEnd();
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={() => endDrag(true)}
				onPointerCancel={() => endDrag(false)}
			/>
			{menu && (
				<div className="draft-pill-menu" style={{ left: menu.left, bottom: menu.bottom }}>
					{menuFile?.preview && <img src={menuFile.preview} alt="" />}
					<div className="draft-pill-meta">
						{menuFile
							? `${menuFile.file.name} · ${formatSize(menuFile.file.size)}`
							: `${(ref.current && pillOf(ref.current, menu.key)?.title) ?? ""}`}
					</div>
					<div className="draft-pill-actions">
						<button type="button" disabled={menuIndex.index <= 0} onClick={() => swap(menu.key, -1)}>
							Earlier
						</button>
						<button
							type="button"
							disabled={menuIndex.index < 0 || menuIndex.index >= menuIndex.count - 1}
							onClick={() => swap(menu.key, 1)}
						>
							Later
						</button>
						<button
							type="button"
							onClick={() => {
								const pill = ref.current && pillOf(ref.current, menu.key);
								setMenu(undefined);
								if (pill) removePill(pill);
							}}
						>
							Remove
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** A pill being pressed, and once it moves: its ghost, the drop caret and the offset it would land at. */
type Drag = {
	readonly pill: HTMLElement;
	readonly x: number;
	readonly y: number;
	moving: { readonly ghost: HTMLElement; readonly caret: HTMLElement; offset: number | undefined } | undefined;
};

/** Caret slots: an empty character next to a pill where no text is, so the caret has a place before and after it. */
const SLOT = "\u200B";

/** The draft an editor's DOM holds (or a fragment of it): text, pills as their references, line breaks. */
function serialize(root: Node): string {
	let text = "";
	const walk = (node: Node) => {
		const children = node.childNodes;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			if (child.nodeType === Node.TEXT_NODE) text += (child.textContent ?? "").replaceAll(SLOT, "");
			else if (isPill(child)) text += child.dataset.token ?? "";
			else if (child.nodeName === "BR") {
				// The last break of the editor is the browser's placeholder (it holds the caret after a pill, or shows
				// an empty last line, whose newline is already text): a break that ends the text shows no line.
				if (index === children.length - 1 && node === root) continue;
				text += "\n";
			} else if (child.nodeName === "DIV" || child.nodeName === "P") {
				if (text !== "" && !text.endsWith("\n")) text += "\n";
				walk(child);
			} else walk(child);
		}
	};
	walk(root);
	return text;
}

function isPill(node: Node | null): node is HTMLElement {
	return node instanceof HTMLElement && node.classList.contains("draft-pill");
}

/**
 * Renders `draft` into the editor: its text and a pill per reference. A reference to no picked file names an upload
 * of the session (a message brought back by Edit or from the queue): its pill has no thumbnail.
 */
function render(editor: HTMLElement, draft: string, files: ReadonlyMap<string, PickedFile>): void {
	const nodes: Node[] = [];
	// Numbered as the model reads them (plugins/chat/worker.ts): by first appearance, one number per file.
	const images = new Map<string, number>();
	for (const part of referenceParts(draft)) {
		if (part.kind === "text") nodes.push(document.createTextNode(part.text));
		else {
			if (part.image && !images.has(part.id)) images.set(part.id, images.size + 1);
			const token = draft.slice(part.start, part.end);
			nodes.push(pillElement(part, token, files.get(part.id), images.get(part.id) ?? 0));
		}
	}
	editor.replaceChildren(...nodes);
	tidy(editor);
}

function pillElement(
	reference: FileReference,
	token: string,
	file: PickedFile | undefined,
	image: number,
): HTMLElement {
	const pill = document.createElement("span");
	pill.className = "draft-pill";
	pill.contentEditable = "false";
	pill.dataset.token = token;
	pill.dataset.key = reference.id;
	if (file) pill.dataset.picked = "";
	pill.title = file ? file.file.name : `${reference.label} (sent before)`;
	if (file?.preview) {
		const thumbnail = document.createElement("img");
		thumbnail.src = file.preview;
		thumbnail.alt = "";
		thumbnail.draggable = false;
		pill.append(thumbnail);
	}
	const label = document.createElement("span");
	label.textContent = image ? `Image ${image}` : reference.label;
	pill.append(label);
	pill.setAttribute("aria-label", file ? `${label.textContent}: ${file.file.name}` : pill.title);
	return pill;
}

/** Caret slots beside pills, a character after a trailing line break (so its line shows), nothing when empty. */
function tidy(editor: HTMLElement): void {
	for (const pill of editor.querySelectorAll<HTMLElement>(".draft-pill")) {
		if (!hasText(pill.nextSibling)) pill.after(SLOT);
		if (!hasText(pill.previousSibling)) pill.before(SLOT);
	}
	const last = editor.lastChild;
	if (last?.nodeType === Node.TEXT_NODE && (last.textContent ?? "").endsWith("\n")) last.after(SLOT);
	if (serialize(editor) === "" && editor.childNodes.length) editor.replaceChildren();
}

function hasText(node: Node | null): boolean {
	return node?.nodeType === Node.TEXT_NODE && (node.textContent ?? "") !== "";
}

/** Whether a pill shows a picked file that went, or an upload whose file was picked since. */
function pillsStale(editor: HTMLElement, files: ReadonlyMap<string, PickedFile>): boolean {
	for (const pill of editor.querySelectorAll<HTMLElement>(".draft-pill"))
		if (files.has(pill.dataset.key ?? "") !== (pill.dataset.picked !== undefined)) return true;
	return false;
}

/** The draft offset of a DOM position in the editor. */
function offsetAt(editor: HTMLElement, node: Node, offset: number): number {
	const range = document.createRange();
	range.setStart(editor, 0);
	range.setEnd(node, offset);
	return serialize(range.cloneContents()).length;
}

/** The selection as draft offsets, when it is in the editor. */
function selectionOffsets(editor: HTMLElement): { start: number; end: number } | undefined {
	const selection = document.getSelection();
	if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return undefined;
	const range = selection.getRangeAt(0);
	return {
		start: offsetAt(editor, range.startContainer, range.startOffset),
		end: offsetAt(editor, range.endContainer, range.endOffset),
	};
}

/** The caret's draft offset: the selection's start, else where it was last in the editor, else the end. */
function caretIn(editor: HTMLElement, last: number | undefined): number {
	return selectionOffsets(editor)?.start ?? last ?? serialize(editor).length;
}

/** The DOM position of a draft offset: after any caret slot, after a pill the offset falls into. */
function positionAt(editor: HTMLElement, target: number): { node: Node; offset: number } {
	let at = 0;
	const walk = (parent: Node): { node: Node; offset: number } | undefined => {
		const children = parent.childNodes;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			if (child.nodeType === Node.TEXT_NODE) {
				const data = child.textContent ?? "";
				for (let i = 0; i <= data.length; i++) {
					if (at === target && (i === data.length || data[i] !== SLOT)) return { node: child, offset: i };
					if (i < data.length && data[i] !== SLOT) at++;
				}
			} else if (isPill(child)) {
				const length = (child.dataset.token ?? "").length;
				if (target === at) return { node: parent, offset: index };
				if (target < at + length) return { node: parent, offset: index + 1 };
				at += length;
			} else if (child.nodeName === "BR") {
				if (target === at) return { node: parent, offset: index };
				at++;
			} else {
				const found = walk(child);
				if (found) return found;
			}
		}
		return undefined;
	};
	return walk(editor) ?? { node: editor, offset: editor.childNodes.length };
}

function select(editor: HTMLElement, start: number, end: number): void {
	const selection = document.getSelection();
	if (!selection) return;
	const from = positionAt(editor, start);
	const to = end === start ? from : positionAt(editor, end);
	const range = document.createRange();
	range.setStart(from.node, from.offset);
	range.setEnd(to.node, to.offset);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** The draft offset under a screen point in the editor (beside a pill by the point's side), if it is in it. */
function offsetAtPoint(editor: HTMLElement, x: number, y: number): number | undefined {
	let node: Node | undefined;
	let offset = 0;
	// Safari before 18.4 has only the older caretRangeFromPoint.
	if ("caretPositionFromPoint" in document) {
		const position = document.caretPositionFromPoint(x, y);
		if (position) ({ offsetNode: node, offset } = position);
	} else {
		const range = (document as Document).caretRangeFromPoint(x, y);
		if (range) ({ startContainer: node, startOffset: offset } = range);
	}
	if (!node || !editor.contains(node)) return undefined;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	const pill = element?.closest<HTMLElement>(".draft-pill");
	if (pill && editor.contains(pill)) {
		const bounds = pill.getBoundingClientRect();
		const start = pillStart(editor, pill);
		return x < bounds.left + bounds.width / 2 ? start : start + (pill.dataset.token ?? "").length;
	}
	return offsetAt(editor, node, offset);
}

/** Where the caret for a draft offset shows: a collapsed range's box, else the edge of the pill beside it. */
function caretRect(editor: HTMLElement, offset: number): { left: number; top: number; height: number } {
	const { node, offset: at } = positionAt(editor, offset);
	const range = document.createRange();
	range.setStart(node, at);
	const box = range.getClientRects()[0];
	if (box?.height) return { left: box.left, top: box.top, height: box.height };
	const after = node.childNodes[at];
	const before = node.childNodes[at - 1];
	const side = after instanceof Element ? after : before instanceof Element ? before : undefined;
	if (side) {
		const bounds = side.getBoundingClientRect();
		return { left: side === after ? bounds.left : bounds.right, top: bounds.top, height: bounds.height };
	}
	const bounds = editor.getBoundingClientRect();
	return { left: bounds.left, top: bounds.top, height: 24 };
}

/** The draft offset where a pill starts. */
function pillStart(editor: HTMLElement, pill: HTMLElement): number {
	const parent = pill.parentNode ?? editor;
	return offsetAt(editor, parent, [...parent.childNodes].indexOf(pill));
}

/** The pill right before (-1) or after (1) a collapsed caret, past caret slots. */
function adjacentPill(editor: HTMLElement, direction: -1 | 1): HTMLElement | undefined {
	const selection = document.getSelection();
	if (!selection?.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return undefined;
	const node = selection.anchorNode;
	const offset = selection.anchorOffset;
	if (node.nodeType === Node.TEXT_NODE) {
		const data = node.textContent ?? "";
		const side = direction < 0 ? data.slice(0, offset) : data.slice(offset);
		if (side.replaceAll(SLOT, "") !== "") return undefined;
		let sibling = direction < 0 ? node.previousSibling : node.nextSibling;
		while (sibling && sibling.nodeType === Node.TEXT_NODE && (sibling.textContent ?? "").replaceAll(SLOT, "") === "")
			sibling = direction < 0 ? sibling.previousSibling : sibling.nextSibling;
		return isPill(sibling) ? sibling : undefined;
	}
	const sibling = node.childNodes[direction < 0 ? offset - 1 : offset] ?? null;
	return isPill(sibling) ? sibling : undefined;
}

function pillOf(editor: HTMLElement, key: string): HTMLElement | undefined {
	return [...editor.querySelectorAll<HTMLElement>(".draft-pill")].find((pill) => pill.dataset.key === key);
}

function pillIndex(editor: HTMLElement, key: string): { index: number; count: number } {
	const pills = [...editor.querySelectorAll<HTMLElement>(".draft-pill")];
	return { index: pills.findIndex((pill) => pill.dataset.key === key), count: pills.length };
}

/** The menu's place above its pill, inside the editor's box. */
function menuPlace(box: HTMLElement, pill: HTMLElement, key: string): PillMenu {
	const outer = box.getBoundingClientRect();
	const bounds = pill.getBoundingClientRect();
	return {
		key,
		left: Math.round(Math.max(0, Math.min(bounds.left - outer.left, outer.width - 260))),
		bottom: Math.round(outer.bottom - bounds.top + 4),
	};
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
