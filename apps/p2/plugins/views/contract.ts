// Views: panes beside the transcript that the person and the agent share (docs/views.md). A view has a kind (a Markdown
// file, the working tree's changes, or a custom HTML view the agent wrote), its own JSON state and the person's
// selection in it; annotations (comments, removals, drawings) mark up any view or the transcript. The session's worker
// owns all of it; the layout of the panes is each device's own (web.tsx).

import { arr, int, nullable, num, obj, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { type JsonValue, literal, method, param, remote, serverHost, sessionHost, unsafe } from "@p2/app/v1";

/** A view's ID: a lowercase slug, unique in its session. */
export const VIEW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The transcript's ID where annotations name the view they mark up: it is no view of its own, but takes notes too. */
export const TRANSCRIPT = "transcript";
/** The largest state a view keeps, as JSON. */
export const MAX_VIEW_STATE = 256 * 1024;
/** The largest custom view's HTML, as UTF-8. */
export const MAX_VIEW_HTML = 2 * 1024 * 1024;
/** How many annotations a session keeps at once. */
export const MAX_ANNOTATIONS = 200;
/** Where a custom view's HTML versions live in the session's files (path: the view's ID). */
export const VIEW_SOURCES = "views";

const Id = str({ pattern: VIEW_ID.source });
/** The kinds of views: a Markdown file of the workspace rendered, the working tree's changes, a custom HTML view. */
export const ViewKindSchema = oneOf(["markdown", "changes", "custom"] as const);
export type ViewKind = Static<typeof ViewKindSchema>;

/**
 * What the person selected in a view, as the view describes it: a summary the agent reads with their next message,
 * and the view's own data. `sent`: their next message carried it already.
 */
export const SelectionSchema = obj({
	summary: str({ minLength: 1, maxLength: 2000 }),
	data: opt(unsafe<JsonValue>(unknown())),
	sent: opt(literal(true)),
});
export type Selection = Static<typeof SelectionSchema>;

/** One view of a session. */
export const ViewSchema = obj({
	id: Id,
	kind: ViewKindSchema,
	title: str({ minLength: 1, maxLength: 120 }),
	/** `markdown`: the file, relative to the workspace; `changes`: only changes below this path. */
	path: opt(str({ maxLength: 4096 })),
	/** `custom`: the version of its HTML in the session's files (`VIEW_SOURCES`). */
	source: opt(int({ minimum: 1 })),
	selection: opt(SelectionSchema),
	/** The custom view's last script errors in the browser, newest last: what the agent sees when it reads the view. */
	errors: opt(arr(str({ maxLength: 1000 }), { maxItems: 10 })),
	/** When the agent last asked to show it: devices bring it to the front (and show it again) when this grows. */
	focus: num(),
	created: num(),
});
export type View = Static<typeof ViewSchema>;

/** A stroke of a drawing: x, y pairs as fractions of the pane's width and height at the time it was drawn. */
const StrokeSchema = arr(num({ minimum: -1, maximum: 2 }), { maxItems: 4000 });

/** What an annotation says, as a person makes it: a comment on text, text to remove, or a drawing over a pane. */
export const AnnotationInputSchema = union([
	obj({
		kind: literal("comment"),
		view: Id,
		quote: str({ minLength: 1, maxLength: 4000 }),
		note: str({ minLength: 1, maxLength: 4000 }),
	}),
	obj({ kind: literal("delete"), view: Id, quote: str({ minLength: 1, maxLength: 4000 }) }),
	obj({
		kind: literal("ink"),
		view: Id,
		strokes: arr(StrokeSchema, { minItems: 1, maxItems: 100 }),
		/** The pane's aspect (width / height) when it was drawn: the drawing keeps its shape. */
		aspect: num({ minimum: 0.01, maximum: 100 }),
		/** Text the drawing covers, as the pane found it under the strokes. */
		under: opt(str({ maxLength: 4000 })),
		note: opt(str({ maxLength: 4000 })),
	}),
]);
export type AnnotationInput = Static<typeof AnnotationInputSchema>;

/** An annotation as the session keeps it: who made it, when, and whether a message carried it to the agent yet. */
export const AnnotationSchema = obj(
	{
		id: str({ minLength: 1, maxLength: 40 }),
		/** The input's fields (`AnnotationInputSchema`), flattened. */
		kind: oneOf(["comment", "delete", "ink"] as const),
		view: Id,
		quote: opt(str()),
		note: opt(str()),
		strokes: opt(arr(StrokeSchema)),
		aspect: opt(num()),
		under: opt(str()),
		author: str(),
		created: num(),
		sent: opt(literal(true)),
	},
	{ open: true },
);
export type Annotation = Static<typeof AnnotationSchema>;

/**
 * How the agent last asked the person's panes to be laid out (`layout.ts`, `arrangementError`), and when: each device
 * adopts it once.
 */
export const ArrangementSchema = obj({ layout: unsafe<JsonValue>(unknown()), stamp: num() });
export type Arrangement = Static<typeof ArrangementSchema>;

/** The session's views and annotations: the worker's `p2.views` document. */
export type ViewsState = { views: View[]; annotations: Annotation[]; arrangement?: Arrangement };

/** What a person opens from the Views sheet: a Markdown file, the changes, or a view of the owner's library. */
export const OpenSchema = union([
	obj({
		kind: literal("markdown"),
		path: str({ minLength: 1, maxLength: 4096 }),
		title: opt(str({ maxLength: 120 })),
	}),
	obj({ kind: literal("changes"), path: opt(str({ maxLength: 4096 })), title: opt(str({ maxLength: 120 })) }),
	obj({ saved: str({ pattern: VIEW_ID.source }) }),
]);

/**
 * A session's views and annotations as anyone who may view the session sees them; people who may send there also open,
 * close and select in views, annotate, and drop what their next message would carry.
 */
export const Views = remote("p2.views", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		reader: {
			state: {
				views: arr(ViewSchema),
				annotations: arr(AnnotationSchema),
				arrangement: nullable(ArrangementSchema),
			},
		},
		editor: {
			state: {
				views: arr(ViewSchema),
				annotations: arr(AnnotationSchema),
				arrangement: nullable(ArrangementSchema),
			},
			methods: {
				open: method(OpenSchema, obj({ id: Id })),
				/** Removes the view, its state and its annotations. */
				close: method(obj({ id: Id })),
				/** Sets (or with `null` clears) the person's selection in a view. */
				select: method(obj({ id: Id, selection: nullable(SelectionSchema) })),
				annotate: method(AnnotationInputSchema, obj({ id: str() })),
				/** Removes annotations: these, or every one without `ids`. */
				unannotate: method(obj({ ids: opt(arr(str(), { maxItems: MAX_ANNOTATIONS })) })),
				/** Drops what the next message would carry: unsent annotations go, selections count as sent. */
				discard: method(),
				/** The custom view's script errors the browser saw (an empty list: none). */
				report: method(obj({ id: Id, errors: arr(str({ maxLength: 1000 }), { maxItems: 10 }) })),
			},
		},
	},
});

/** One view's JSON state (null until something sets it): everyone who may view reads it, people who may send set it. */
export const ViewState = remote("p2.view-state", {
	version: 1,
	params: { session: param.str(), view: param.str() },
	hostAddress: sessionHost,
	variants: {
		reader: { state: { value: unsafe<JsonValue>(unknown()) } },
		editor: {
			state: { value: unsafe<JsonValue>(unknown()) },
			methods: { set: method(obj({ value: unsafe<JsonValue>(unknown()) })) },
		},
	},
});

/** A custom view's HTML for the server's `/view-frame` route (the worker owns the bytes; the route authorizes). */
export const ViewSource = remote("p2.view-source", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				read: method(obj({ view: Id, version: int({ minimum: 1 }) }), obj({ title: str(), html: str() })),
			},
		},
	},
});

/** A view in the owner's library: what opening it in any session starts from. */
export const SavedViewSchema = obj({
	name: Id,
	title: str({ minLength: 1, maxLength: 120 }),
	description: opt(str({ maxLength: 2000 })),
	kind: ViewKindSchema,
	path: opt(str({ maxLength: 4096 })),
	/** `custom`: its HTML. */
	html: opt(str()),
	state: unsafe<JsonValue>(unknown()),
	saved: num(),
});
export type SavedView = Static<typeof SavedViewSchema>;
/** A saved view without its HTML and state, for lists. */
export const SavedInfoSchema = obj({
	name: Id,
	title: str(),
	description: opt(str()),
	kind: ViewKindSchema,
	saved: num(),
});
export type SavedInfo = Static<typeof SavedInfoSchema>;

/**
 * The owner's library of saved views (`<data>/views/<name>.json`, server): the owner lists and removes them; session
 * workers list, read and save them for their agent's `view` tool and for the owner's Views sheet.
 */
export const SavedViews = remote("p2.saved-views", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: { saved: arr(SavedInfoSchema) }, methods: { remove: method(obj({ name: Id })) } },
		worker: {
			methods: {
				list: method(undefined, arr(SavedInfoSchema)),
				get: method(obj({ name: Id }), nullable(SavedViewSchema)),
				save: method(SavedViewSchema, SavedInfoSchema),
			},
		},
	},
});

/** The entry kind of a person's message that carried view context (selections, annotations) to the agent. */
export const VIEW_INPUT = "p2.view-input";
