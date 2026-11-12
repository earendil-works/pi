// Views: panes beside the transcript that the person and the agent share (docs/views.md). A view has a kind (a Markdown
// file, the working tree's changes, or a kind a plugin's web facet registers, such as an html or md artifact) and the
// item it shows, and the person's selection in it; annotations (comments, removals, drawings) mark up any view or the
// transcript. The session's worker owns all of it; the layout of the panes is each device's own (web.tsx).

import {
	arr,
	int,
	nul,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	type Ctx,
	evolve,
	type JsonValue,
	keyedRegistry,
	literal,
	method,
	param,
	propertiesOf,
	remote,
	sessionHost,
	unsafe,
} from "@p2/app/v1";

/** A view's ID: a lowercase slug, unique in its session. */
export const VIEW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The transcript's ID where annotations name the view they mark up: it is no view of its own, but takes notes too. */
export const TRANSCRIPT = "transcript";
/** How many annotations a session keeps at once. */
export const MAX_ANNOTATIONS = 200;

const Id = str({ pattern: VIEW_ID.source });
/** The kinds `Views` version 1 knew. */
const ViewKindSchemaV1 = oneOf(["markdown", "changes", "custom"] as const);
/** The built-in kinds: a Markdown file of the workspace rendered, the working tree's changes. */
export const BUILT_IN_KINDS: readonly string[] = ["markdown", "changes"];

/**
 * A view's kind: a built-in one or the name a plugin's web facet registered its pane under (`ViewKinds`: `html` and
 * `md` artifacts, a plugin the agent wrote); a page that has no pane for it says so.
 */
export const ViewKindNameSchema = str({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });

/** What a view shows: a Markdown file's path, the path changes are shown below, a plugin's item ID (an artifact's). */
export const ViewItemSchema = str({ minLength: 1, maxLength: 4096 });

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

/** One view of a session, as `Views` version 1 has it. */
const ViewSchemaV1 = obj({
	id: Id,
	kind: ViewKindSchemaV1,
	title: str({ minLength: 1, maxLength: 120 }),
	path: opt(str({ maxLength: 4096 })),
	source: opt(int({ minimum: 1 })),
	selection: opt(SelectionSchema),
	errors: opt(arr(str({ maxLength: 1000 }), { maxItems: 10 })),
	focus: num(),
	created: num(),
});
type ViewV1 = Static<typeof ViewSchemaV1>;

/** One view of a session, as `Views` version 2 has it: a plugin's kind too. */
const ViewSchemaV2 = obj({ ...propertiesOf(ViewSchemaV1), kind: ViewKindNameSchema });
type ViewV2 = Static<typeof ViewSchemaV2>;

/** One view of a session: what it is (its kind and the item it shows), its title and the person's selection. */
export const ViewSchema = obj({
	id: Id,
	kind: ViewKindNameSchema,
	/** `markdown`: the file, relative to the workspace; `changes`: only changes below this path; a plugin's item ID. */
	item: opt(ViewItemSchema),
	title: str({ minLength: 1, maxLength: 120 }),
	selection: opt(SelectionSchema),
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

/**
 * What the person selected in an item shown in the transcript (an artifact a script showed there): no view holds it,
 * so the session keeps it by the item's kind and ID, one per item.
 */
export const InlineSelectionSchema = obj({
	kind: ViewKindNameSchema,
	item: ViewItemSchema,
	title: str({ minLength: 1, maxLength: 120 }),
	selection: SelectionSchema,
});
export type InlineSelection = Static<typeof InlineSelectionSchema>;

/** What `selectInline` takes: the item and its selection (`null` clears it). */
export const SelectInlineSchema = obj({
	kind: ViewKindNameSchema,
	item: ViewItemSchema,
	title: str({ minLength: 1, maxLength: 120 }),
	selection: nullable(SelectionSchema),
});
export type SelectInlineInput = Static<typeof SelectInlineSchema>;

/**
 * The session's views and annotations: the worker's `p2.views` document. Views of the removed `custom` kind may still
 * be stored there (no migration): `liveViews` leaves them out.
 */
export type ViewsState = {
	views: View[];
	annotations: Annotation[];
	arrangement?: Arrangement;
	/** Selections in items shown in the transcript (absent in documents written before). */
	inline?: InlineSelection[];
};

/** The views of `state` that still exist: every kind but the removed `custom` one. */
export const liveViews = (state: Readonly<ViewsState>): View[] => state.views.filter((view) => view.kind !== "custom");

/** What a person opens from the Views sheet or the artifacts sheet: a Markdown file, the changes, a plugin's item. */
export const OpenSchema = obj({
	kind: ViewKindNameSchema,
	item: opt(ViewItemSchema),
	title: opt(str({ minLength: 1, maxLength: 120 })),
});
export type OpenInput = Static<typeof OpenSchema>;

/** What version 2's editors opened: a Markdown file, the changes, or a saved view (gone). */
const OpenSchemaV2 = union([
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
export const ViewsV1 = remote("p2.views", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		reader: {
			state: {
				views: arr(ViewSchemaV1),
				annotations: arr(AnnotationSchema),
				arrangement: nullable(ArrangementSchema),
			},
		},
		editor: {
			state: {
				views: arr(ViewSchemaV1),
				annotations: arr(AnnotationSchema),
				arrangement: nullable(ArrangementSchema),
			},
			methods: {
				open: method(OpenSchemaV2, obj({ id: Id })),
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

/** Version 2: a view's kind may be a plugin's. */
const ViewsV2 = evolve(ViewsV1, (e) =>
	e.state("reader", "views", arr(ViewSchemaV2)).state("editor", "views", arr(ViewSchemaV2)),
);

/** Version 3: a view shows an `item` (`path` before); the custom kind, its source and errors, saved views and `report` are gone. */
const ViewsV3 = evolve(ViewsV2, (e) =>
	e
		.state("reader", "views", arr(ViewSchema))
		.state("editor", "views", arr(ViewSchema))
		.args("open", OpenSchema)
		.removeMethod("report"),
);

/**
 * The session's views and annotations (see `ViewsV1`). 2: a view's kind may be a plugin's. 3: a view shows an `item`
 * (`path` before); the custom kind, its source and errors, saved views and `report` are gone. 4: selections in items
 * shown in the transcript (`inline`, `selectInline`). Pages built with 1 to 3 get what they can show (`VIEWS_ACCEPTS`).
 */
export const Views = evolve(ViewsV3, (e) =>
	e
		.addState("reader", "inline", arr(InlineSelectionSchema))
		.addState("editor", "inline", arr(InlineSelectionSchema))
		/** Sets (or with `null` clears) the person's selection in an item shown in the transcript. */
		.addMethod("editor", "selectInline", SelectInlineSchema, nul()),
);

/** A view as versions 1 and 2 have it: its item as `path` (only the built-in kinds had one). */
const asV2 = (view: View): ViewV2 => {
	const { item, ...rest } = view;
	return { ...rest, ...(item !== undefined && BUILT_IN_KINDS.includes(view.kind) ? { path: item } : {}) };
};

/** What pages built with older versions of `Views` see and send. */
export const VIEWS_ACCEPTS: AcceptsTable<typeof Views> = {
	1: {
		state: {
			reader: {
				views: (views) => views.map(asV2).filter((view): view is ViewV1 => BUILT_IN_KINDS.includes(view.kind)),
			},
			editor: {
				views: (views) => views.map(asV2).filter((view): view is ViewV1 => BUILT_IN_KINDS.includes(view.kind)),
			},
		},
		// Custom views and their errors are gone: what an older page reports changes nothing.
		methods: { open: { args: openOfV2 }, report: { call: async () => null } },
	},
	2: {
		state: { reader: { views: (views) => views.map(asV2) }, editor: { views: (views) => views.map(asV2) } },
		// Custom views and their errors are gone: what an older page reports changes nothing.
		methods: { open: { args: openOfV2 }, report: { call: async () => null } },
	},
	3: {},
};

/** An older page's open: a Markdown file or the changes (saved views are gone). */
function openOfV2(old: Static<typeof OpenSchemaV2>): OpenInput {
	if ("saved" in old) throw new Error("Saved views are gone");
	return {
		kind: old.kind,
		...(old.path ? { item: old.path } : {}),
		...(old.title ? { title: old.title } : {}),
	};
}

/** The entry kind of a person's message that carried view context (selections, annotations) to the agent. */
export const VIEW_INPUT = "p2.view-input";

/**
 * Context another plugin adds to a person's next message, beside the views' selections and annotations (the html
 * artifacts' new page errors): a text block the model reads, a short note the transcript shows, and what to mark once
 * the message carried it.
 */
export type MessageContext = {
	readonly text: string;
	readonly note: string;
	readonly carried: (ctx: Ctx) => Promise<void>;
};

/** Worker registry of message contexts, by plugin: each says what is new for the next message (undefined: nothing). */
export const MessageContexts =
	keyedRegistry<(ctx: Ctx) => Promise<MessageContext | undefined>>("p2.views-message-contexts");
