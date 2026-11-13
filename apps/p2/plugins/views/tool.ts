// The agent's view tools, for code mode only (namespace `view`): list the session's views with the person's selections
// and annotations, open (or show again) a view of any kind a web facet registered, close one, arrange the person's
// panes, and resolve annotations. They act on the session's documents only.
import { defineExtension, type ToolExecutionApi, type ToolNamespace } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { type Context, type JsonValue, propertiesOf, unsafe } from "@p2/app/v1";
import { defineP2Tool, type P2Tool } from "@p2/app/v1/worker";
import {
	AnnotationSchema,
	ArrangementSchema,
	SelectionSchema,
	TRANSCRIPT,
	VIEW_ID,
	type View,
	ViewItemSchema,
	ViewKindNameSchema,
} from "./contract.ts";
import { describeAnnotation, freeViewId, openView, readViews, removeView, ViewsDoc, viewName } from "./doc.ts";
import { arrangementError } from "./layout.ts";

/** The namespace of the view tools in code mode. */
export const VIEW_NAMESPACE: ToolNamespace = {
	name: "view",
	description:
		"Views: panes beside the transcript every viewer of the session sees (markdown files, the changes, artifacts, plugins' panes): list, open, close, arrange, resolve annotations.",
	instructions: [
		"A view has a kind and the item it shows: markdown (item: a file relative to your working directory, rendered again when it changes), changes (the working tree's diffs; item: an optional path to narrow them), and any kind a plugin's web facet registers (item: the plugin's item ID, e.g. an artifact's; artifact_open opens artifacts for you).",
		"view_open with an existing id shows that view again and brings it to the front; update views rather than opening new ones.",
		"view_arrange lays out the person's panes once: a node is a view ID ('transcript' is the chat), {tabs: [IDs], active: ID} or {row or column: [nodes], sizes: [shares]}; views left out are hidden, and the person may rearrange afterwards.",
		"What the person selects and annotates (comments, text to remove, drawings) arrives with their messages in a <views> block; view_list shows the annotations nobody resolved, view_resolve removes them.",
	].join("\n"),
};

/** A layout node: a view ID, tabs, or a row or column of nodes with their shares (`layout.ts`, `arrangementError`). */
const LayoutNodeSchema = unsafe<JsonValue>({
	anyOf: [
		{ type: "string", description: "A view ID ('transcript' is the chat)" },
		{
			type: "object",
			properties: { tabs: { type: "array", items: { type: "string" } }, active: { type: "string" } },
			required: ["tabs"],
		},
		{
			type: "object",
			properties: { row: { type: "array" }, sizes: { type: "array", items: { type: "number" } } },
			required: ["row"],
		},
		{
			type: "object",
			properties: { column: { type: "array" }, sizes: { type: "array", items: { type: "number" } } },
			required: ["column"],
		},
	],
});

/** One view as `view_list` lists it. */
const ListedViewSchema = obj({ id: str(), kind: str(), item: opt(str()), title: str() });

/** What `view_list` returns. */
const ListSchema = obj({
	views: arr(ListedViewSchema),
	arrangement: opt(ArrangementSchema),
	/**
	 * The person's selection in each view that has one, with the view's data; in an item shown in the transcript, `view`
	 * is `transcript` with the item's kind and ID.
	 */
	selections: arr(obj({ view: str(), kind: opt(str()), item: opt(str()), ...propertiesOf(SelectionSchema) })),
	/** The annotations nobody resolved, each with a line describing it. */
	annotations: arr(obj({ ...propertiesOf(AnnotationSchema), text: str() }, { open: true })),
});

/** The tools' result details: what the call did, to which view (the chat's card). */
export type ViewDetails = { action: string; id?: string; title?: string; kind?: string };

/** A tool of the set: code mode only, its outcome as a structured value and one line of text. */
function viewTool<A extends object>(tool: {
	name: string;
	description: string;
	parameters: object;
	output: object;
	replay: "safe" | "unsafe";
	run: (
		args: A,
		api: ToolExecutionApi,
		context: Context,
	) => Promise<{ value: JsonValue; text: string; details: ViewDetails }>;
}): P2Tool {
	return defineP2Tool<A>({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as never,
		structuredOutputSchema: tool.output as never,
		callers: ["tools"],
		replay: tool.replay,
		execute: async (args, api, context) => {
			try {
				const { value, text, details } = await tool.run(args as A, api, context);
				return { output: [{ type: "text" as const, text }], structuredOutput: value, details };
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return { output: [{ type: "text" as const, text }], isError: true, details: { action: tool.name } };
			}
		},
	});
}

/** The view tools. */
export function createViewsExtension() {
	return defineExtension<P2Tool>({
		name: "p2-views",
		namespace: VIEW_NAMESPACE,
		tools: [
			viewTool<Record<string, never>>({
				name: "view_list",
				description:
					"The session's views (id, kind, item, title), the layout you arranged last, the person's selections and the annotations nobody resolved.",
				parameters: obj({}),
				output: ListSchema,
				replay: "safe",
				run: async (_args, api, context) => {
					const state = await readViews(api, context);
					const value = {
						views: state.views.map(({ id, kind, item, title }) => ({
							id,
							kind,
							...(item ? { item } : {}),
							title,
						})),
						...(state.arrangement ? { arrangement: state.arrangement } : {}),
						selections: [
							...state.views.flatMap((view) => (view.selection ? [{ view: view.id, ...view.selection }] : [])),
							...(state.inline ?? []).map(({ kind, item, selection }) => ({
								view: TRANSCRIPT,
								kind,
								item,
								...selection,
							})),
						],
						annotations: state.annotations.map((annotation) => ({
							...annotation,
							text: describeAnnotation(state.views, annotation),
						})),
					};
					const text = state.views.length
						? state.views.map((view) => `- ${viewName(state.views, view.id)}`).join("\n")
						: "No views are open.";
					return { value, text, details: { action: "list" } };
				},
			}),
			viewTool<{ kind: string; item?: string; title?: string; id?: string }>({
				name: "view_open",
				description:
					"Opens a view beside the transcript (or, with the id of one, shows it again with what you give): kind markdown (item: a file), changes (item: an optional path), or a plugin's kind (item: its item ID). Returns its id.",
				parameters: obj({
					kind: ViewKindNameSchema,
					item: opt(ViewItemSchema),
					title: opt(str({ minLength: 1, maxLength: 120 })),
					id: opt(str({ pattern: VIEW_ID.source })),
				}),
				output: obj({ id: str() }),
				replay: "unsafe",
				run: async ({ kind, item, title, id: asked }, api, context) => {
					const view = await openViewOf({ kind, item, title, id: asked }, api, context);
					return {
						value: { id: view.id },
						text: `Opened ${viewName([view], view.id)}. The person sees it beside the transcript.`,
						details: detailsOf("open", view),
					};
				},
			}),
			viewTool<{ id: string }>({
				name: "view_close",
				description: "Closes a view (its annotations go with it).",
				parameters: obj({ id: str({ maxLength: 64 }) }),
				output: obj({ closed: str() }),
				replay: "safe",
				run: async ({ id }, api, context) => {
					const view = (await readViews(api, context)).views.find((each) => each.id === id);
					if (!view) throw new Error(`No view "${id}"`);
					await api.commit((tx) => removeView(tx, id), context);
					return { value: { closed: id }, text: `Closed view "${id}".`, details: detailsOf("close", view) };
				},
			}),
			viewTool<{ layout: JsonValue }>({
				name: "view_arrange",
				description:
					"Lays out the person's panes: a node is a view ID ('transcript' is the chat), {tabs: [IDs], active: ID} or {row or column: [nodes], sizes: [shares]}; views left out are hidden.",
				parameters: obj({ layout: LayoutNodeSchema }),
				output: obj({ arranged: unsafe<JsonValue>(unknown()) }),
				replay: "safe",
				run: async ({ layout }, api, context) => {
					const state = await readViews(api, context);
					const error = arrangementError(layout, new Set([TRANSCRIPT, ...state.views.map((view) => view.id)]));
					if (error) throw new Error(`layout: ${error}`);
					await api.commit(async (tx) => {
						(await tx.doc(ViewsDoc)).arrangement = { layout, stamp: api.now() };
					}, context);
					return {
						value: { arranged: layout },
						text: "Arranged the person's panes; they may rearrange them.",
						details: { action: "arrange" },
					};
				},
			}),
			viewTool<{ annotations?: string[]; view?: string }>({
				name: "view_resolve",
				description:
					"Removes annotations you dealt with: these IDs, or every one on a view ('transcript' for the chat's).",
				parameters: obj({ annotations: opt(arr(str(), { maxItems: 200 })), view: opt(str({ maxLength: 64 })) }),
				output: obj({ resolved: int() }),
				replay: "safe",
				run: async ({ annotations, view }, api, context) => {
					const ids = new Set(annotations ?? []);
					if (!ids.size && view === undefined) throw new Error("Give annotations (ids) or view (all of a view's)");
					const removed = await api.commit(async (tx) => {
						const draft = await tx.doc(ViewsDoc);
						const before = draft.annotations.length;
						draft.annotations = draft.annotations.filter(
							(annotation) => !ids.has(annotation.id) && (view === undefined || annotation.view !== view),
						);
						return before - draft.annotations.length;
					}, context);
					return {
						value: { resolved: removed },
						text: `Resolved ${removed} annotation${removed === 1 ? "" : "s"}.`,
						details: { action: "resolve" },
					};
				},
			}),
		],
	});
}

/**
 * Opens view `spec` (or shows the one with its ID again): checked as the agent asked for it. A markdown view needs its
 * file; a missing title is the item's or the kind's.
 */
async function openViewOf(
	spec: { kind: string; item?: string; title?: string; id?: string },
	api: ToolExecutionApi,
	context: Context,
): Promise<View> {
	const state = await readViews(api, context);
	if (spec.id === TRANSCRIPT) throw new Error("id: not transcript (the chat is no view)");
	const existing = spec.id === undefined ? undefined : state.views.find((view) => view.id === spec.id);
	if (existing && existing.kind !== spec.kind)
		throw new Error(`View "${existing.id}" is a ${existing.kind} view, not ${spec.kind}`);
	const item = spec.item ?? existing?.item;
	if (spec.kind === "markdown" && item === undefined) throw new Error("A markdown view needs item (the file)");
	const title =
		spec.title ??
		existing?.title ??
		(spec.kind === "changes" ? (item ? `Changes in ${item}` : "Changes") : (item ?? spec.kind));
	const id = spec.id ?? freeViewId(state, title, spec.kind);
	return api.commit(
		(tx) => openView(tx, { id, kind: spec.kind, title: title.slice(0, 120), ...(item ? { item } : {}) }, api.now()),
		context,
	);
}

const detailsOf = (action: string, view: View): ViewDetails => ({
	action,
	id: view.id,
	title: view.title,
	kind: view.kind,
});
