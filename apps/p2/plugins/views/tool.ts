// The agent's `view` tool: lists, opens, reads, changes and closes the session's views, saves them to (and loads them
// from) the owner's library, and explains a custom view's page API on request (kept out of the description, which
// every request carries). What it reaches beyond the session's documents comes in through `ViewsBackend`.
import { defineExtension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type Context, type JsonValue, unsafe } from "@p2/app/v1";
import { defineP2Tool, type P2Tool } from "@p2/app/v1/worker";
import {
	BUILT_IN_KINDS,
	isBuiltInKind,
	MAX_VIEW_HTML,
	type SavedInfo,
	type SavedView,
	TRANSCRIPT,
	VIEW_ID,
	type View,
	ViewKindNameSchema,
} from "./contract.ts";
import {
	describeAnnotation,
	freeViewId,
	openView,
	readViewState,
	readViews,
	removeView,
	setViewState,
	ViewStateDoc,
	ViewsDoc,
	viewName,
} from "./doc.ts";
import { arrangementError } from "./layout.ts";

/** What the tool reaches outside the session's documents: the session's files and the owner's library. */
export type ViewsBackend = {
	/** Saves `html` as the next version of view `id`'s source; its version. */
	saveSource(id: string, html: string, context: Context): Promise<number>;
	/** Version `version` of view `id`'s source. */
	readSource(id: string, version: number, context: Context): Promise<string>;
	/** The newest version of HTML artifact `name`. */
	readArtifact(name: string, context: Context): Promise<string>;
	listSaved(context: Context): Promise<readonly SavedInfo[]>;
	getSaved(name: string, context: Context): Promise<SavedView | null>;
	save(view: SavedView, context: Context): Promise<SavedInfo>;
};

/** The tool's result details: what the call did, to which view (the chat's card). */
export type ViewDetails = { action: string; id?: string; title?: string; kind?: string };

/** A read shows at most this much of a state's JSON, and says how much there is. */
const MAX_READ_STATE = 40_000;

const DESCRIPTION = [
	"Views: panes beside the transcript that the person sees and works in. Open one when seeing or editing something beside the chat helps more than text (a document, the changes, an editor you build for what you work on together); update views rather than opening new ones. Every viewer of the session sees them.",
	"Kinds: markdown (path: a file relative to your working directory, rendered again when it changes), changes (the working tree's diffs; optional path narrows them), custom (html: a page you write, with JSON state; call help before writing one; for single-player artifacts), and any kind a p2 plugin's web facet registers (its name; the plugin's pane shows it, with the view's state: multiplayer or persistent things are plugins).",
	"Actions: list; open (kind, title; id updates and shows an existing view; path; html, or artifact to copy an HTML artifact; state); read (id: its state, the person's selection, its page's errors, annotations; id transcript: the transcript's annotations); update (id: title, path, html, state to replace, or merge to add keys); close (id); arrange (layout): lay out the person's panes, e.g. {row: ['transcript', {column: ['plan', {tabs: ['glyph', 'notes']}]}], sizes: [1, 2]} as JSON: a node is a view ID ('transcript' is the chat), {tabs: [IDs], active: ID} or {row or column: [nodes], sizes: [shares]}; views left out are hidden, and the person may rearrange afterwards; resolve (annotations: ids, or id for all of a view's); save (id, name, description), saved, load (name): the owner's library; help: the custom page API.",
	"What the person selects and annotates (comments, text to remove, drawings) arrives with their messages in a <views> block.",
].join("\n");

/** What `help` answers: how a custom view's page talks to p2. */
const PAGE_API = [
	"A custom view is a whole HTML page (at most 2 MiB) in a sandboxed frame with no app identity; it may load https CDN resources. It talks to p2 through window.p2view:",
	"- p2view.onState(fn): calls fn(state, from) with the view's state now (from: init) and at each change made elsewhere (from: update, by you or another device). Render from it.",
	"- p2view.setState(next): saves the state (any JSON, at most 256 KiB; or a function of the current state). Call it on every edit; saving waits for a short pause.",
	"- p2view.select(summary, data) / p2view.clearSelection(): the person's selection. summary is one line you read with their next message; data is what read shows.",
	"- p2view.readOnly: true for viewers who cannot change the session; their changes are not saved.",
	"- p2view.onDescribeRegion(fn): fn({x, y, width, height}) returns text naming what lies there (CSS pixels of the page), for drawings the person makes over it; without it, the labels and texts of the elements there (aria-label or data-label attributes help).",
	"Keep the document's own data in the state, not only in the page: the state is what you read and change, and what a saved view keeps. Script errors the page logs show when you read the view.",
	"",
	"Rooms: every browser showing the view (each frame, people the session is shared with included) can share a room on the server. The first call opens the frame's own connection; pages that only render and save state need none.",
	"- const room = p2view.room('live'): presence and messages. room.me, room.peers ([{id, name, role, mode}]; mode read: watches only), room.leader / room.isLeader (the oldest frame that may write), room.onPeers(fn(peers, leader)).",
	"  Three ways to share, by what the others need: (1) motion (paddles, drags, pointers, game inputs): room.emit(data, {key}) reaches every frame there now through room.onEvent(fn({from, key, at, data})) (returns its removal), often and fast; nothing is numbered, kept or replayed, and a busy link sends only the newest per key (at most maxInFlight unanswered, p2view.room(kind, {maxInFlight: 32})). Put your own sample time in data (room.now()). (2) What a joiner needs (positions to start from, a ball's trajectory, cursors): room.send(data, {key: 'ball'}): the newest per key and frame is kept and given to joiners. (3) Commands every frame must get, in one order (moves of a turn-based game; log rooms): room.send(data), numbered; all of (2) and (3) arrive through room.onMessage(fn({seq, from, key, data})), own messages too. send resolves with its outcome: {kind: 'sent', seq}, 'superseded' (a newer one with its key replaced it before it left), 'refused' (with error) or 'uncertain' (the link closed first: it may or may not have arrived; resend with your own command ID to dedupe).",
	"  room.now(): the server's clock (re-sampled every 10 s), for a shared clock (games); room.rtt(): the round trip in ms.",
	"- p2view.room('log'): messages since a snapshot, for turn-based games or a shared canvas. room.onReset(fn(state, seq)) gives the state to start from (the view's state at first), then onMessage the moves after it. The leader saves now and then: if (room.isLeader) room.snapshot(state) (the state after every message applied so far; it becomes the view's state). Your update of the state resets the room to it.",
	"- const text = p2view.room('text'): one shared text the server merges (concurrent typing is safe). text.bind(textareaOrInput), or text.value / text.set(next) / text.onChange(fn(value, from)); text.onCursors(fn([{peer, name, anchor, head}])) for others' carets. The text is the view state's text field; your update of text is merged as an edit.",
	"Methods for you: p2view.methods.offer({ zoom: { description: 'Zoom to a region', args: {type: 'object', properties: {x: {type: 'number'}}, required: ['x']}, run: async (args) => ({ zoomed: args.x }) } }). From code mode: await tools.view_methods({ view }) lists them, await tools.view_call({ view, method: 'zoom', args: { x: 2 } }) runs one in the leader's frame and returns its result (fails at once when no browser shows the view; 'uncertain' when the frame left before answering). Offer idempotent: true for methods safe to run twice.",
].join("\n");

/** A view's state, or keys to merge into it: a JSON object. */
const JsonObjectSchema = unsafe<{ [key: string]: JsonValue }>({ type: "object" });

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

/**
 * The call's arguments with `state`, `merge` and `layout` given as JSON text parsed (a harness that sends objects as
 * strings): the trust boundary's fallback. Anything else stays as it came; Durable checks the result against the
 * parameters.
 */
function withJsonArguments<T>(raw: unknown): T {
	// Checked against the tool's parameters right after this step (Durable's `prepareArguments`).
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw as T;
	const args: Record<string, unknown> = { ...raw };
	for (const key of ["state", "merge", "layout"] as const) {
		const value = args[key];
		if (typeof value !== "string") continue;
		try {
			const parsed: unknown = JSON.parse(value);
			// A layout's plain string is a view ID; only an object (or array) given as JSON text is parsed.
			if (parsed !== null && typeof parsed === "object") args[key] = parsed;
		} catch {
			// Not JSON: left as it came, for the parameters' check to refuse (or, for a layout, a view ID).
		}
	}
	return args as T;
}

/** The `view` tool. */
export function createViewsExtension(backend: ViewsBackend) {
	return defineExtension<P2Tool>({
		name: "p2-views",
		tools: [
			defineP2Tool({
				name: "view",
				description: DESCRIPTION,
				parameters: obj(
					{
						action: oneOf([
							"list",
							"open",
							"read",
							"update",
							"close",
							"resolve",
							"save",
							"saved",
							"load",
							"help",
							"arrange",
						] as const),
						id: opt(str({ maxLength: 64 })),
						kind: opt(ViewKindNameSchema),
						title: opt(str({ minLength: 1, maxLength: 120 })),
						path: opt(str({ maxLength: 4096 })),
						html: opt(str()),
						artifact: opt(str({ maxLength: 64 })),
						state: opt(JsonObjectSchema),
						merge: opt(JsonObjectSchema),
						layout: opt(LayoutNodeSchema),
						annotations: opt(arr(str(), { maxItems: 200 })),
						name: opt(str({ maxLength: 64 })),
						description: opt(str({ maxLength: 2000 })),
					},
					{ open: true },
				),
				replay: "unsafe",
				prepareArguments: withJsonArguments,
				execute: async (args, api, context) => {
					try {
						return await run(args, api, backend, context);
					} catch (error) {
						return reply(error instanceof Error ? error.message : String(error), { action: args.action }, true);
					}
				},
			}),
		],
	});
}

type Args = {
	action: "list" | "open" | "read" | "update" | "close" | "resolve" | "save" | "saved" | "load" | "help" | "arrange";
	id?: string;
	/** A built-in kind, or one a plugin's web facet registered. */
	kind?: string;
	title?: string;
	path?: string;
	html?: string;
	artifact?: string;
	/** An object from the agent; a saved view's state (`load`) may be any JSON. */
	state?: JsonValue;
	merge?: { [key: string]: JsonValue };
	layout?: JsonValue;
	annotations?: string[];
	name?: string;
	description?: string;
};

const reply = (text: string, details: ViewDetails, isError = false) => ({
	output: [{ type: "text" as const, text }],
	details,
	...(isError ? { isError: true } : {}),
});

const detailsOf = (action: string, view: View): ViewDetails => ({
	action,
	id: view.id,
	title: view.title,
	kind: view.kind,
});

/** Runs one call; a thrown error is the call's failure. */
async function run(args: Args, api: ToolExecutionApi, backend: ViewsBackend, context: Context) {
	switch (args.action) {
		case "list":
			return reply(await listText(api, context), { action: "list" });
		case "help":
			return reply(PAGE_API, { action: "help" });
		case "arrange": {
			const layout = required(args.layout, "layout");
			const state = await readViews(api, context);
			const error = arrangementError(layout, new Set([TRANSCRIPT, ...state.views.map((view) => view.id)]));
			if (error) throw new Error(`layout: ${error}`);
			await api.commit(async (tx) => {
				(await tx.doc(ViewsDoc)).arrangement = { layout, stamp: api.now() };
			}, context);
			return reply("Arranged the person's panes; they may rearrange them.", { action: "arrange" });
		}
		case "open":
			return open(args, api, backend, context);
		case "read":
			return read(required(args.id, "id"), api, context);
		case "update":
			return update(args, api, backend, context);
		case "close": {
			const id = required(args.id, "id");
			const view = await viewOf(api, id, context);
			await api.commit((tx) => removeView(tx, id), context);
			return reply(`Closed view "${id}".`, detailsOf("close", view));
		}
		case "resolve":
			return resolve(args, api, context);
		case "save":
			return save(args, api, backend, context);
		case "saved": {
			const saved = await backend.listSaved(context);
			const lines = saved.map(
				(each) => `- ${each.name} (${each.kind}): ${each.title}${each.description ? ` — ${each.description}` : ""}`,
			);
			return reply(saved.length ? `Saved views:\n${lines.join("\n")}` : "No saved views.", { action: "saved" });
		}
		case "load": {
			const name = required(args.name, "name");
			const saved = await backend.getSaved(name, context);
			if (!saved) throw new Error(`No saved view "${name}"`);
			return open(
				{
					action: "open",
					kind: saved.kind,
					title: saved.title,
					state: saved.state,
					id: args.id ?? freeViewId(await readViews(api, context), saved.name, saved.kind),
					...(saved.path ? { path: saved.path } : {}),
					...(saved.html ? { html: saved.html } : {}),
				},
				api,
				backend,
				context,
			);
		}
	}
}

/** Every view with its selection, and the annotations nobody resolved. */
async function listText(api: ToolExecutionApi, context: Context): Promise<string> {
	const state = await readViews(api, context);
	const views = state.views.map((view) => {
		const notes = state.annotations.filter((annotation) => annotation.view === view.id).length;
		return `- ${viewName(state.views, view.id)}${view.selection ? `; selected: ${view.selection.summary}` : ""}${
			notes ? `; ${notes} annotation${notes === 1 ? "" : "s"}` : ""
		}${view.errors?.length ? `; ${view.errors.length} script error(s), read it` : ""}`;
	});
	const annotations = state.annotations.map((annotation) => `- ${describeAnnotation(state.views, annotation)}`);
	return [
		views.length ? `Views:\n${views.join("\n")}` : "No views are open.",
		...(state.arrangement ? [`Layout you arranged last: ${JSON.stringify(state.arrangement.layout)}`] : []),
		...(annotations.length ? [`Annotations:\n${annotations.join("\n")}`] : []),
	].join("\n");
}

async function open(args: Args, api: ToolExecutionApi, backend: ViewsBackend, context: Context) {
	const kind = required(args.kind, "kind");
	const title = required(args.title, "title");
	const state = await readViews(api, context);
	if (args.id !== undefined && (!VIEW_ID.test(args.id) || args.id === TRANSCRIPT))
		throw new Error("id: a lowercase slug (a-z, 0-9, - and _), not transcript");
	const id = args.id ?? freeViewId(state, title, kind);
	const existing = state.views.find((view) => view.id === id);
	if (existing && existing.kind !== kind) throw new Error(`View "${id}" is a ${existing.kind} view, not ${kind}`);
	if (kind === "markdown" && !args.path && !existing?.path) throw new Error("A markdown view needs path");
	// A plugin's kind: its pane (the plugin's web facet) shows it, with the view's state; no path or HTML of its own.
	if (!BUILT_IN_KINDS.includes(kind) && (args.path !== undefined || args.html !== undefined || args.artifact))
		throw new Error(`A ${kind} view is a plugin's pane: give it a title and, if it reads one, a state`);
	let source: number | undefined;
	if (kind === "custom") {
		const html = args.html ?? (args.artifact ? await backend.readArtifact(args.artifact, context) : undefined);
		if (html === undefined && !existing?.source) throw new Error("A custom view needs html or artifact");
		if (html !== undefined) source = await backend.saveSource(id, checkedHtml(html), context);
	}
	const view = await api.commit(
		(tx) =>
			openView(
				tx,
				{
					id,
					kind,
					title,
					...(args.path !== undefined ? { path: args.path } : {}),
					...(source !== undefined ? { source } : {}),
					...(args.state !== undefined ? { state: args.state } : {}),
				},
				api.now(),
			),
		context,
	);
	return reply(
		`${existing ? "Updated and showed" : "Opened"} ${viewName([view], view.id)}. The person sees it beside the transcript.`,
		detailsOf("open", view),
	);
}

async function read(id: string, api: ToolExecutionApi, context: Context) {
	const state = await readViews(api, context);
	const annotations = state.annotations.filter((annotation) => annotation.view === id);
	const notes = annotations.map((annotation) => `- ${describeAnnotation(state.views, annotation)}`);
	if (id === TRANSCRIPT)
		return reply(
			notes.length ? `Annotations on the transcript:\n${notes.join("\n")}` : "No annotations on the transcript.",
			{
				action: "read",
				id,
			},
		);
	const view = state.views.find((each) => each.id === id);
	if (!view) throw new Error(`No view "${id}". Views: ${state.views.map((each) => each.id).join(", ") || "none"}`);
	const value = await readViewState(api, id, context);
	const json = JSON.stringify(value);
	const lines = [
		`${viewName(state.views, id)}${view.source ? `, source version ${view.source}` : ""}.`,
		view.selection
			? `Selected: ${view.selection.summary}${view.selection.data !== undefined ? `\nSelection data: ${JSON.stringify(view.selection.data)}` : ""}`
			: "Nothing selected.",
		json.length > MAX_READ_STATE
			? `State (${json.length} characters of JSON, the first ${MAX_READ_STATE}): ${json.slice(0, MAX_READ_STATE)}`
			: `State: ${json}`,
		...(view.errors?.length
			? [`Script errors its page logged:\n${view.errors.map((error) => `- ${error}`).join("\n")}`]
			: []),
		...(notes.length ? [`Annotations:\n${notes.join("\n")}`] : []),
	];
	return reply(lines.join("\n"), detailsOf("read", view));
}

async function update(args: Args, api: ToolExecutionApi, backend: ViewsBackend, context: Context) {
	const id = required(args.id, "id");
	const current = await viewOf(api, id, context);
	if (args.state !== undefined && args.merge !== undefined) throw new Error("Give state or merge, not both");
	const merge = args.merge;
	const source =
		args.html === undefined
			? undefined
			: current.kind === "custom"
				? await backend.saveSource(id, checkedHtml(args.html), context)
				: undefined;
	if (args.html !== undefined && source === undefined) throw new Error("Only custom views have html");
	await api.commit(async (tx) => {
		const draft = await tx.doc(ViewsDoc);
		const target = draft.views.find((each) => each.id === id);
		if (!target) throw new Error(`No view "${id}"`);
		if (args.title !== undefined) target.title = args.title;
		if (args.path !== undefined) target.path = args.path;
		if (source !== undefined) {
			target.source = source;
			// The new page logs its own errors.
			delete target.errors;
		}
		if (args.state !== undefined || merge !== undefined) {
			const doc = await tx.doc(ViewStateDoc, id, null);
			setViewState(
				doc,
				merge === undefined ? (args.state ?? null) : { ...(isObject(doc.value) ? doc.value : {}), ...merge },
				"other",
			);
		}
	}, context);
	const view = await viewOf(api, id, context);
	const changed = [
		args.title !== undefined && "title",
		args.path !== undefined && "path",
		source !== undefined && `html (version ${source})`,
		args.state !== undefined && "state",
		merge !== undefined && "state (merged)",
	].filter(Boolean);
	return reply(`Updated ${viewName([view], id)}: ${changed.join(", ") || "nothing"}.`, detailsOf("update", view));
}

async function resolve(args: Args, api: ToolExecutionApi, context: Context) {
	const ids = new Set(args.annotations ?? []);
	if (!ids.size && args.id === undefined) throw new Error("Give annotations (ids) or id (all of a view's)");
	const removed = await api.commit(async (tx) => {
		const draft = await tx.doc(ViewsDoc);
		const before = draft.annotations.length;
		draft.annotations = draft.annotations.filter(
			(annotation) => !ids.has(annotation.id) && (args.id === undefined || annotation.view !== args.id),
		);
		return before - draft.annotations.length;
	}, context);
	return reply(`Resolved ${removed} annotation${removed === 1 ? "" : "s"}.`, { action: "resolve" });
}

async function save(args: Args, api: ToolExecutionApi, backend: ViewsBackend, context: Context) {
	const view = await viewOf(api, required(args.id, "id"), context);
	const kind = view.kind;
	if (!isBuiltInKind(kind))
		throw new Error(`A ${kind} view is a plugin's: the library keeps markdown, changes and custom views only`);
	const name = args.name ?? view.id;
	if (!VIEW_ID.test(name)) throw new Error("name: a lowercase slug (a-z, 0-9, - and _)");
	const html =
		view.kind === "custom" && view.source ? await backend.readSource(view.id, view.source, context) : undefined;
	const info = await backend.save(
		{
			name,
			title: view.title,
			kind,
			state: await readViewState(api, view.id, context),
			saved: api.now(),
			...(args.description ? { description: args.description } : {}),
			...(view.path ? { path: view.path } : {}),
			...(html !== undefined ? { html } : {}),
		},
		context,
	);
	return reply(
		`Saved ${viewName([view], view.id)} as "${info.name}" in the owner's library; load it in any session with load.`,
		detailsOf("save", view),
	);
}

/** View `id` as committed; a missing one fails the call. */
async function viewOf(api: ToolExecutionApi, id: string, context: Context): Promise<View> {
	const view = (await readViews(api, context)).views.find((each) => each.id === id);
	if (!view) throw new Error(`No view "${id}"`);
	return view;
}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`${name} is required for this action`);
	return value;
}

function checkedHtml(html: string): string {
	if (Buffer.byteLength(html, "utf8") > MAX_VIEW_HTML) throw new Error("html exceeds 2 MiB");
	return html;
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
