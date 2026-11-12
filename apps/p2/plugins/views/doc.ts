// The views' Durable documents (session scope, worker) and the changes and texts the `view` tool, the `Views` object
// and the send router share: adding and removing views, annotations, and the context a person's message carries.
import { type DocumentReader, defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@p2/app/v1";
import {
	type Annotation,
	type AnnotationInput,
	MAX_ANNOTATIONS,
	MAX_VIEW_STATE,
	TRANSCRIPT,
	VIEW_ID,
	type View,
	type ViewsState,
} from "./contract.ts";

/** The session's views and annotations. */
export const ViewsDoc = defineDoc<ViewsState>({
	kind: "p2.views",
	version: 1,
	scope: "session",
	initial: () => ({ views: [], annotations: [] }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 32,
});

/**
 * Each view's JSON state, keyed by the view's ID; retired with the view. `revision` grows with every write and `by`
 * says whose it was (a view's room, or anyone else): a room writes only over the revision it saw (docs/rooms.md).
 */
export type ViewStateValue = { value: JsonValue; revision?: number; by?: "room" | "other" };
export const ViewStateDoc = defineDocFamily<ViewStateValue, null>({
	kind: "p2.view-state",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ value: null }),
	// A state change replaces the whole value: a delta is as large as a base.
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 8,
});

/**
 * A text room's own state (docs/rooms.md: the text, its IDs, the editors' watermarks), keyed by the view's ID; written
 * only by its room through `ViewBacking`, retired with the view.
 */
export const ViewRoomDoc = defineDocFamily<{ value: JsonValue }, null>({
	kind: "p2.view-room",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ value: null }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 8,
});

/** Sets view state `doc` to `value`, written by `by`: the revision grows. */
export function setViewState(doc: ViewStateValue, value: JsonValue, by: "room" | "other"): void {
	doc.value = checkedState(value);
	doc.revision = (doc.revision ?? 0) + 1;
	doc.by = by;
}

/** The session's views and annotations as committed (empty before the first view). */
export async function readViews(read: DocumentReader, context: Context): Promise<Readonly<ViewsState>> {
	return (await read.snapshot(ViewsDoc, context)) ?? { views: [], annotations: [] };
}

/** A view's state as committed (null when nothing set it). */
export async function readViewState(read: DocumentReader, id: string, context: Context): Promise<JsonValue> {
	return (await read.snapshot(ViewStateDoc, id, context))?.value ?? null;
}

/** A free view ID made from `title` (or `kind`): its slug, numbered when taken. */
export function freeViewId(state: Readonly<ViewsState>, title: string, kind: string): string {
	const slug =
		title
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || kind;
	const base = VIEW_ID.test(slug) && slug !== TRANSCRIPT ? slug : `view-${slug}`.slice(0, 48);
	const taken = new Set(state.views.map((view) => view.id));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A state value as JSON, refused past `MAX_VIEW_STATE`. */
export function checkedState(value: JsonValue): JsonValue {
	const size = JSON.stringify(value)?.length ?? 0;
	if (size > MAX_VIEW_STATE) throw new Error(`View state is ${size} characters of JSON; at most ${MAX_VIEW_STATE}`);
	return value;
}

/** What opening a view sets: a new view, or the one with its ID updated and brought to the front. */
export type ViewSpec = {
	readonly id: string;
	/** A built-in kind, or a plugin's. */
	readonly kind: string;
	readonly title: string;
	readonly path?: string;
	readonly source?: number;
	readonly state?: JsonValue;
};

/**
 * Opens a view: adds it, or updates the one with its ID (same kind; its selection, errors and unset fields stay) and
 * brings it to the front. `state` replaces its state.
 */
export async function openView(tx: Tx, spec: ViewSpec, now: number): Promise<View> {
	const draft = await tx.doc(ViewsDoc);
	const at = draft.views.findIndex((each) => each.id === spec.id);
	const existing = at < 0 ? undefined : draft.views[at];
	if (existing && existing.kind !== spec.kind) throw new Error(`View "${spec.id}" is a ${existing.kind} view`);
	const view: View = {
		...existing,
		id: spec.id,
		kind: spec.kind,
		title: spec.title,
		focus: now,
		created: existing?.created ?? now,
		...(spec.path !== undefined ? { path: spec.path } : {}),
		...(spec.source !== undefined ? { source: spec.source } : {}),
	};
	if (spec.source !== undefined) delete view.errors;
	if (at < 0) {
		draft.views.push(view);
		// A new opening: tokens, frames and rooms of an earlier view under this ID never reach this one.
		draft.opened = { ...draft.opened, [spec.id]: crypto.randomUUID() };
	} else draft.views[at] = view;
	if (spec.state !== undefined) setViewState(await tx.doc(ViewStateDoc, spec.id, null), spec.state, "other");
	return view;
}

/** Removes view `id` with its state and annotations; false when there is none. */
export async function removeView(tx: Tx, id: string): Promise<boolean> {
	const draft = await tx.doc(ViewsDoc);
	const at = draft.views.findIndex((view) => view.id === id);
	if (at < 0) return false;
	draft.views.splice(at, 1);
	draft.annotations = draft.annotations.filter((annotation) => annotation.view !== id);
	if (draft.opened) delete draft.opened[id];
	await tx.retireDoc(ViewStateDoc, id);
	await tx.retireDoc(ViewRoomDoc, id);
	return true;
}

/** Adds an annotation by `author` on a view of the session or the transcript; returns its ID. */
export function addAnnotation(draft: ViewsState, input: AnnotationInput, author: string, now: number): string {
	if (input.view !== TRANSCRIPT && !draft.views.some((view) => view.id === input.view))
		throw new Error(`No view "${input.view}"`);
	const id = `a${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
	draft.annotations.push({ ...input, id, author, created: now });
	if (draft.annotations.length > MAX_ANNOTATIONS)
		draft.annotations.splice(0, draft.annotations.length - MAX_ANNOTATIONS);
	return id;
}

/** Where a view is, as the agent reads it: `view "notes" (markdown docs/notes.md)`. */
export function viewName(views: readonly View[], id: string): string {
	if (id === TRANSCRIPT) return "the transcript";
	const view = views.find((each) => each.id === id);
	if (!view) return `view "${id}" (closed)`;
	const where = view.path ? ` ${view.path}` : "";
	return `view "${id}" (${view.kind}${where}, "${view.title}")`;
}

/** Text quoted on one line, shortened to `max` characters. */
export function quoted(text: string, max = 600): string {
	const line = text.replace(/\s+/g, " ").trim();
	return `«${line.length > max ? `${line.slice(0, max)}…` : line}»`;
}

/** One annotation as the agent reads it. */
export function describeAnnotation(views: readonly View[], annotation: Annotation): string {
	const where = viewName(views, annotation.view);
	const by = ` (${annotation.author}${annotation.sent ? ", sent before" : ""}, id ${annotation.id})`;
	switch (annotation.kind) {
		case "comment":
			return `Comment in ${where} on ${quoted(annotation.quote ?? "")}: ${annotation.note ?? ""}${by}`;
		case "delete":
			return `Remove from ${where}: ${quoted(annotation.quote ?? "")}${by}`;
		case "ink": {
			const under = annotation.under ? ` over ${quoted(annotation.under)}` : "";
			const note = annotation.note ? `: ${annotation.note}` : "";
			const box = inkBox(annotation.strokes ?? []);
			return `Drawing in ${where}${under}${box}${note}${by}`;
		}
	}
}

/** Where a drawing lies in its pane, in percent of the pane's width and height. */
function inkBox(strokes: readonly (readonly number[])[]): string {
	let [left, top, right, bottom] = [1, 1, 0, 0];
	for (const stroke of strokes)
		for (let i = 0; i + 1 < stroke.length; i += 2) {
			left = Math.min(left, stroke[i] ?? 1);
			right = Math.max(right, stroke[i] ?? 0);
			top = Math.min(top, stroke[i + 1] ?? 1);
			bottom = Math.max(bottom, stroke[i + 1] ?? 0);
		}
	if (right < left) return "";
	const pct = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100);
	return ` (strokes at ${pct(left)}–${pct(right)}% across, ${pct(top)}–${pct(bottom)}% down the pane)`;
}

/** What one message carries: its text, and which selections and annotations it describes (`markSent`). */
export type Carried = {
	readonly text: string;
	readonly annotations: readonly string[];
	readonly selections: readonly { readonly view: string; readonly summary: string }[];
};

/**
 * What a person's next message carries to the agent: the selections and annotations it has not carried yet, as one
 * block after the message; undefined when there is nothing new.
 */
export function viewContext(state: Readonly<ViewsState>): Carried | undefined {
	const selections = state.views.filter((view) => view.selection && !view.selection.sent);
	const annotations = state.annotations.filter((annotation) => !annotation.sent);
	if (!selections.length && !annotations.length) return undefined;
	const text = [
		"<views>",
		"From the views beside the transcript (the view tool reads and changes them):",
		...selections.map((view) => `Selected in ${viewName(state.views, view.id)}: ${view.selection?.summary ?? ""}`),
		...(annotations.length
			? [
					"Annotations the person made:",
					...annotations.map(
						(annotation, index) => `${index + 1}. ${describeAnnotation(state.views, annotation)}`,
					),
				]
			: []),
		"</views>",
	].join("\n");
	return {
		text,
		annotations: annotations.map((annotation) => annotation.id),
		selections: selections.map((view) => ({ view: view.id, summary: view.selection?.summary ?? "" })),
	};
}

/**
 * Marks what a message carried as sent: those annotations, and those selections unless they changed meanwhile (a
 * selection made while the message was on its way waits for the next one).
 */
export function markSent(draft: ViewsState, carried: Carried): void {
	const annotations = new Set(carried.annotations);
	for (const annotation of draft.annotations) if (annotations.has(annotation.id)) annotation.sent = true;
	for (const { view, summary } of carried.selections) {
		const selection = draft.views.find((each) => each.id === view)?.selection;
		if (selection?.summary === summary) selection.sent = true;
	}
}
