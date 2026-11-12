// The views' Durable document (session scope, worker) and the changes and texts the `view_*` tools, the `Views` object
// and the send router share: adding and removing views, annotations, and the context a person's message carries.
import { type DocumentReader, defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@p2/app/v1";
import {
	type Annotation,
	type AnnotationInput,
	liveViews,
	MAX_ANNOTATIONS,
	type SelectInlineInput,
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

/** The session's live views and annotations as committed (empty before the first view). */
export async function readViews(read: DocumentReader, context: Context): Promise<Readonly<ViewsState>> {
	const state = await read.snapshot(ViewsDoc, context);
	return state ? { ...state, views: liveViews(state) } : { views: [], annotations: [] };
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

/** What opening a view sets: a new view, or the one with its ID updated and brought to the front. */
export type ViewSpec = {
	readonly id: string;
	/** A built-in kind, or a plugin's. */
	readonly kind: string;
	readonly title: string;
	readonly item?: string;
};

/**
 * Opens a view: adds it, or updates the one with its ID (same kind; its selection and unset fields stay) and brings it
 * to the front.
 */
export async function openView(tx: Tx, spec: ViewSpec, now: number): Promise<View> {
	const draft = await tx.doc(ViewsDoc);
	// A stored view of the removed custom kind under this ID is replaced, as if it were gone.
	const at = draft.views.findIndex((each) => each.id === spec.id);
	const existing = at < 0 || draft.views[at]?.kind === "custom" ? undefined : draft.views[at];
	if (existing && existing.kind !== spec.kind) throw new Error(`View "${spec.id}" is a ${existing.kind} view`);
	const view: View = {
		id: spec.id,
		kind: spec.kind,
		title: spec.title,
		focus: now,
		created: existing?.created ?? now,
		...(spec.item !== undefined ? { item: spec.item } : existing?.item !== undefined ? { item: existing.item } : {}),
		...(existing?.selection ? { selection: existing.selection } : {}),
	};
	if (at < 0) draft.views.push(view);
	else draft.views[at] = view;
	return view;
}

/** Removes view `id` with its annotations; false when there is none. */
export async function removeView(tx: Tx, id: string): Promise<boolean> {
	const draft = await tx.doc(ViewsDoc);
	const at = draft.views.findIndex((view) => view.id === id);
	if (at < 0) return false;
	draft.views.splice(at, 1);
	draft.annotations = draft.annotations.filter((annotation) => annotation.view !== id);
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
	const where = view.item ? ` ${view.item}` : "";
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
	/** Selections in items shown in the transcript, by `inlineKey`. */
	readonly inline: readonly { readonly key: string; readonly summary: string }[];
};

/** An item shown in the transcript, as `inline` selections are keyed: its kind and ID. */
export const inlineKey = (selection: { readonly kind: string; readonly item: string }): string =>
	`${selection.kind}:${selection.item}`;

/**
 * What a person's next message carries to the agent: the selections and annotations it has not carried yet, as one
 * block after the message; undefined when there is nothing new.
 */
export function viewContext(state: Readonly<ViewsState>): Carried | undefined {
	const selections = state.views.filter((view) => view.selection && !view.selection.sent);
	const inline = (state.inline ?? []).filter((each) => !each.selection.sent);
	const annotations = state.annotations.filter((annotation) => !annotation.sent);
	if (!selections.length && !inline.length && !annotations.length) return undefined;
	const text = [
		"<views>",
		"From the views beside the transcript (code mode's view_* tools list and change them):",
		...selections.map((view) => `Selected in ${viewName(state.views, view.id)}: ${view.selection?.summary ?? ""}`),
		...inline.map(
			(each) =>
				`Selected in ${each.kind} "${each.item}" ("${each.title}") shown in the transcript: ${each.selection.summary}`,
		),
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
		inline: inline.map((each) => ({ key: inlineKey(each), summary: each.selection.summary })),
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
	for (const { key, summary } of carried.inline) {
		const selection = draft.inline?.find((each) => inlineKey(each) === key)?.selection;
		if (selection?.summary === summary) selection.sent = true;
	}
}

/** Sets (or with `null` clears) the person's selection in an item shown in the transcript. */
export function selectInline(draft: ViewsState, input: SelectInlineInput): void {
	const key = inlineKey(input);
	const others = (draft.inline ?? []).filter((each) => inlineKey(each) !== key);
	const { selection } = input;
	draft.inline =
		selection === null
			? others
			: [
					...others,
					{
						kind: input.kind,
						item: input.item,
						title: input.title,
						selection: {
							summary: selection.summary,
							...(selection.data !== undefined ? { data: selection.data } : {}),
						},
					},
				];
}
