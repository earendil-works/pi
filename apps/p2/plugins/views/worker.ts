// Views (worker): the session's views and annotations as browsers hold them (`Views`, `ViewState`), a custom view's
// HTML for the server's frame route (`ViewSource`), the agent's `view` tool, and the send router that adds what the
// person selected and annotated to their next message.
import type { Harness as DurableHarness, JsonObject, SessionDocFamilyToken, Tx } from "@earendil-works/pi-durable";
import {
	type Author,
	authorOf,
	type Context,
	type Ctx,
	canSend,
	canView,
	contribute,
	DEFAULT_OWNER_NAME,
	defineFacet,
	deriveTyped,
	expectVariant,
	forbidden,
	invalid,
	isGuest,
	isOwner,
	type MessageData,
	type Ref,
	type Self,
} from "@p2/app/v1";
import { ARTIFACTS, Files, readWhole } from "@p2/app/v1/node";
import { Extensions, harnessOf, type WorkerParts, workerOf } from "@p2/app/v1/worker";
import { readArtifact } from "../artifacts/store.ts";
import { Conversation, SendRouters } from "../chat/contract.ts";
import { Attachments, MAX_ATTACHMENTS } from "../files/contract.ts";
import { WorkerModels } from "../models/contract.ts";
import {
	LEGACY_OPENING,
	MAX_VIEW_HTML,
	type SavedView,
	SavedViews,
	VIEW_INPUT,
	VIEW_SOURCES,
	type View,
	ViewSource,
	ViewState,
	Views,
	type ViewsState,
} from "./contract.ts";
import {
	addAnnotation,
	freeViewId,
	markSent,
	openView,
	readViews,
	removeView,
	setViewState,
	ViewRoomDoc,
	ViewStateDoc,
	ViewsDoc,
	viewContext,
} from "./doc.ts";
import { ViewBacking, ViewOpenings, ViewRoom } from "./room-contract.ts";
import { createRoomExtension, type RoomsBackend } from "./room-tools.ts";
import { createViewsExtension, type ViewsBackend } from "./tool.ts";

/** The most a selection's data may hold, as JSON: the agent reads it with the view. */
const MAX_SELECTION_DATA = 16 * 1024;

export default defineFacet((host) => {
	contribute(host, "p2.view-tools", (self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const backend = viewsBackend((fn, context) => worker().root(fn, context));
		const extension = createViewsExtension(backend);
		const rooms = createRoomExtension(roomsBackend(() => worker().init.values.session.id, worker));
		self.contribute(Extensions, { [extension.name]: extension, [rooms.name]: rooms });

		/** Validates upload IDs of this session, as any input's. */
		const resolve = async (ids: readonly string[], conversation: number, ctx: Ctx) => {
			const attachments = await ctx.get(Attachments, {});
			const files = [];
			for (let start = 0; start < ids.length; start += MAX_ATTACHMENTS)
				files.push(
					...(await attachments.resolve({ ids: ids.slice(start, start + MAX_ATTACHMENTS), conversation }, ctx)),
				);
			return files;
		};
		// A message with new selections or annotations carries them after its text (the model's copy only: the
		// transcript shows what the person wrote, and a note). Others go on to the next router, or become plain inputs.
		self.contribute(SendRouters, {
			views: async ({ conversation, author, text, requestId, whenBusy, attachments }, ctx) => {
				const durable = harness().durable;
				const carried = viewContext(await readViews(durable, ctx));
				if (!carried) return undefined;
				const files = attachments.length ? await resolve(attachments, conversation, ctx) : [];
				const data: MessageData & { views: { selections: number; annotations: number } } = {
					author,
					text,
					attachments: files.map(({ id, name }) => ({ id, name })),
					views: { selections: carried.selections.length, annotations: carried.annotations.length },
				};
				const chat = await ctx.get(Conversation, { conversation });
				const submitted = await chat.submit(
					{
						text: text.trim() ? `${text}\n\n${carried.text}` : carried.text,
						requestId,
						author,
						files,
						entry: { kind: VIEW_INPUT, data },
						...(whenBusy ? { whenBusy } : {}),
					},
					ctx,
				);
				await durable.commit(async (tx) => markSent(await tx.doc(ViewsDoc), carried), ctx);
				return submitted;
			},
		});
	});

	host.serve(Views, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const index = followViews(self);
		const views = deriveTyped(self, [index], ([value]) => value.views);
		const annotations = deriveTyped(self, [index], ([value]) => value.annotations);
		const arrangement = deriveTyped(self, [index], ([value]) => value.arrangement ?? null);
		if (!canSend(principal, session) || (!isOwner(principal) && !isGuest(principal)))
			return { variant: "reader", members: { views, annotations, arrangement } };
		const person = principal;
		const settings = self.get(WorkerModels, {});
		const author = (): Author => authorOf(person, settings.settings.value.ownerName ?? DEFAULT_OWNER_NAME);
		/** A person's call: refused while the session moves, which waits for running calls (as the chat's). */
		const call = <T>(fn: () => Promise<T>): Promise<T> => worker().liveness.call(fn);
		const commit = <T>(change: (draft: Awaited<ReturnType<typeof viewsDraft>>) => T, ctx: Ctx): Promise<T> =>
			call(() => harness().durable.commit(async (tx) => change(await viewsDraft(tx)), ctx));
		const backend = viewsBackend((fn, context) => worker().root(fn, context));
		return {
			variant: "editor",
			members: {
				views,
				annotations,
				arrangement,
				open: (input, ctx) =>
					call(async () => {
						const durable = harness().durable;
						const now = Date.now();
						if ("saved" in input) {
							if (!isOwner(person)) throw forbidden("saved views are the owner's");
							const saved = await backend.getSaved(input.saved, ctx);
							if (!saved) throw invalid("args", `No saved view "${input.saved}"`);
							const view = await openSaved(saved, backend, durable, now, ctx);
							return { id: view.id };
						}
						const title =
							input.title ||
							(input.kind === "markdown" ? input.path : input.path ? `Changes in ${input.path}` : "Changes");
						const id = freeViewId(await readViews(durable, ctx), title, input.kind);
						const view = await durable.commit(
							(tx) =>
								openView(tx, { id, kind: input.kind, title, ...(input.path ? { path: input.path } : {}) }, now),
							ctx,
						);
						return { id: view.id };
					}),
				close: async ({ id }, ctx) => {
					await call(() => harness().durable.commit((tx) => removeView(tx, id), ctx));
					return null;
				},
				select: async ({ id, selection }, ctx) => {
					if (JSON.stringify(selection?.data ?? null).length > MAX_SELECTION_DATA)
						throw invalid("args", "Selection data is too large");
					await commit((draft) => {
						const view = draft.views.find((each) => each.id === id);
						if (!view) throw invalid("args", `No view "${id}"`);
						if (selection === null) delete view.selection;
						else
							view.selection = {
								summary: selection.summary,
								...(selection.data !== undefined ? { data: selection.data } : {}),
							};
					}, ctx);
					return null;
				},
				annotate: async (input, ctx) => {
					const id = await commit((draft) => addAnnotation(draft, input, author().name, Date.now()), ctx);
					return { id };
				},
				unannotate: async ({ ids }, ctx) => {
					const remove = ids === undefined ? undefined : new Set(ids);
					await commit((draft) => {
						draft.annotations = remove ? draft.annotations.filter((each) => !remove.has(each.id)) : [];
					}, ctx);
					return null;
				},
				discard: async (ctx) => {
					await commit((draft) => {
						draft.annotations = draft.annotations.filter((each) => each.sent);
						for (const view of draft.views) if (view.selection) view.selection.sent = true;
					}, ctx);
					return null;
				},
				report: async ({ id, errors }, ctx) => {
					await commit((draft) => {
						const view = draft.views.find((each) => each.id === id);
						if (!view || view.kind !== "custom") return;
						if (errors.length) view.errors = errors;
						else delete view.errors;
					}, ctx);
					return null;
				},
			},
		};
	});

	host.serve(ViewState, ({ session, view: id }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const harness = harnessOf(self);
		const doc = followViewDoc(self, ViewStateDoc, id, () => true);
		const value = deriveTyped(self, [doc], ([state]) => state.value);
		if (!canSend(principal, session) || (!isOwner(principal) && !isGuest(principal)))
			return { variant: "reader", members: { value } };
		const worker = workerOf(self);
		return {
			variant: "editor",
			members: {
				value,
				set: async ({ value: next }, ctx) => {
					const durable = harness().durable;
					await worker().liveness.call(() =>
						durable.commit(async (tx) => {
							if (!(await tx.doc(ViewsDoc)).views.some((view) => view.id === id))
								throw invalid("args", `No view "${id}"`);
							setViewState(await tx.doc(ViewStateDoc, id, null), next, "other");
						}, ctx),
					);
					return null;
				},
			},
		};
	});

	// The server's side of a custom view's room (docs/rooms.md): the views' current openings, and one opening's state.
	host.serve(ViewOpenings, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const index = followViews(self);
		return { variant: "server", members: { openings: deriveTyped(self, [index], ([value]) => openingsOf(value)) } };
	});

	host.serve(ViewBacking, ({ view: id, opening }, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const current = (state: Readonly<ViewsState>) => openingsOf(state)[id] === opening;
		const state = followViewDoc(self, ViewStateDoc, id, current);
		const room = followViewDoc(self, ViewRoomDoc, id, current);
		return {
			variant: "server",
			members: {
				current: deriveTyped(self, [state], ([doc]) => ({
					value: doc.value,
					revision: doc.revision ?? 0,
					by: doc.by ?? "other",
				})),
				room: deriveTyped(self, [room], ([doc]) => doc.value),
				write: ({ revision, value, room: next }, ctx) =>
					worker().liveness.call(() =>
						harness().durable.commit(async (tx) => {
							if (!current(await tx.doc(ViewsDoc))) return false;
							const doc = await tx.doc(ViewStateDoc, id, null);
							if ((doc.revision ?? 0) !== revision) return false;
							if (next !== undefined) (await tx.doc(ViewRoomDoc, id, null)).value = next;
							if (value !== undefined) setViewState(doc, value, "room");
							return true;
						}, ctx),
					),
			},
		};
	});

	host.serve(ViewSource, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const files = self.get(Files, {});
		return {
			variant: "server",
			members: {
				read: async ({ view: id, version }, ctx) => {
					const view = (await readViews(harness().durable, ctx)).views.find((each) => each.id === id);
					if (view?.kind !== "custom" || !view.source || version > view.source)
						throw invalid("args", "View not found");
					return { title: view.title, html: await sourceOf(files, id, version, ctx) };
				},
			},
		};
	});
});

/** The session's views document, followed (created empty when absent: an absent address cannot be followed). */
function followViews(self: Self) {
	const harness = harnessOf(self);
	return self.follow(async (observer, ctx) => {
		const durable = harness().durable;
		const observed = await durable.observeDoc(ViewsDoc, observer, ctx);
		if (observed !== undefined) return observed;
		await durable.commit(async (tx) => {
			await tx.doc(ViewsDoc);
		}, ctx);
		return durable.observeDoc(ViewsDoc, observer, ctx);
	});
}

/**
 * View `id`'s document of family `family`, followed; created when absent if the views document has a view `id` that
 * `admits` accepts, else the activation fails.
 */
function followViewDoc<T extends JsonObject>(
	self: Self,
	family: SessionDocFamilyToken<T, null>,
	id: string,
	admits: (state: Readonly<ViewsState>) => boolean,
) {
	const harness = harnessOf(self);
	return self.follow(async (observer, ctx) => {
		const durable = harness().durable;
		const views = await readViews(durable, ctx);
		if (!views.views.some((view) => view.id === id) || !admits(views)) throw invalid("params", `No view "${id}"`);
		const observed = await durable.observeDoc(family, id, observer, ctx);
		if (observed !== undefined) return observed;
		await durable.commit(async (tx) => {
			await tx.doc(family, id, null);
		}, ctx);
		return durable.observeDoc(family, id, observer, ctx);
	});
}

/** Each custom view's current opening. */
function openingsOf(state: Readonly<ViewsState>): Record<string, string> {
	const openings: Record<string, string> = {};
	for (const view of state.views)
		if (view.kind === "custom") openings[view.id] = state.opened?.[view.id] ?? LEGACY_OPENING;
	return openings;
}

/** The views document's draft in `tx`. */
const viewsDraft = (tx: Tx) => tx.doc(ViewsDoc);

/** The tool's and the Views sheet's way to the session's files and the owner's library, in roots of the worker's own. */
function viewsBackend(root: <T>(fn: (ctx: Ctx) => Promise<T>, context: Context) => Promise<T>): ViewsBackend {
	const library = (ctx: Ctx) => ctx.get(SavedViews, {}).then((saved) => expectVariant(saved, "worker"));
	return {
		saveSource: (id, html, context) =>
			root(async (ctx) => {
				const file = await (await ctx.get(Files, {})).put(
					{
						space: VIEW_SOURCES,
						path: id,
						mime: "text/html",
						source: "agent",
						bytes: Buffer.from(html, "utf8"),
					},
					ctx,
				);
				return file.version;
			}, context),
		readSource: (id, version, context) =>
			root(async (ctx) => sourceOf(await ctx.get(Files, {}), id, version, ctx), context),
		readArtifact: (name, context) =>
			root(async (ctx) => {
				const files = await ctx.get(Files, {});
				const newest = await files.get({ space: ARTIFACTS, path: name }, ctx);
				if (!newest) throw new Error(`No artifact "${name}"`);
				const { info, content } = await readArtifact(files, name, newest.version, ctx);
				if (info.type !== "html") throw new Error(`Artifact "${name}" is ${info.type}, not HTML`);
				return content;
			}, context),
		listSaved: (context) => root(async (ctx) => (await library(ctx)).list(ctx), context),
		getSaved: (name, context) => root(async (ctx) => (await library(ctx)).get({ name }, ctx), context),
		save: (view, context) => root(async (ctx) => (await library(ctx)).save(view, ctx), context),
	};
}

/** The agent's way to its views' rooms on the server, in roots of the worker's own (it acts as the worker there). */
function roomsBackend(session: () => string, worker: () => WorkerParts): RoomsBackend {
	const room = async (view: string, opening: string, ctx: Ctx) =>
		expectVariant(await ctx.get(ViewRoom, { session: session(), view, opening }), "worker");
	return {
		methods: (view, opening, context) =>
			worker().root(async (ctx) => (await room(view, opening, ctx)).methods(ctx), context),
		call: (view, opening, method, args, context) =>
			worker().root(async (ctx) => (await room(view, opening, ctx)).call({ method, args }, ctx), context),
	};
}

/** Opens saved view `saved` in this session under a free ID made from its name. */
async function openSaved(
	saved: SavedView,
	backend: ViewsBackend,
	durable: DurableHarness,
	now: number,
	context: Context,
): Promise<View> {
	const state = await readViews(durable, context);
	const id = freeViewId(state, saved.name, saved.kind);
	const source = saved.html === undefined ? undefined : await backend.saveSource(id, saved.html, context);
	return durable.commit(
		(tx) =>
			openView(
				tx,
				{
					id,
					kind: saved.kind,
					title: saved.title,
					state: saved.state,
					...(saved.path ? { path: saved.path } : {}),
					...(source !== undefined ? { source } : {}),
				},
				now,
			),
		context,
	);
}

/** Version `version` of view `id`'s HTML from the session's files. */
async function sourceOf(files: Ref<typeof Files>, id: string, version: number, ctx: Ctx): Promise<string> {
	const file = await files.get({ space: VIEW_SOURCES, path: id, version }, ctx);
	if (file === null || file.size > MAX_VIEW_HTML) throw new Error("View not found");
	return (await readWhole(files, file, ctx)).toString("utf8");
}
