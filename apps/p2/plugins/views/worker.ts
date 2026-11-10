// Views (worker): the session's views and annotations as browsers hold them (`Views`, `ViewState`), a custom view's
// HTML for the server's frame route (`ViewSource`), the agent's `view` tool, and the send router that adds what the
// person selected and annotated to their next message.
import type { Harness as DurableHarness, Tx } from "@earendil-works/pi-durable";
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
} from "@p2/app/v1";
import { ARTIFACTS, Files, readWhole } from "@p2/app/v1/node";
import { Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { readArtifact } from "../artifacts/store.ts";
import { Conversation, SendRouters } from "../chat/contract.ts";
import { Attachments, MAX_ATTACHMENTS } from "../files/contract.ts";
import { WorkerModels } from "../models/contract.ts";
import {
	MAX_VIEW_HTML,
	type SavedView,
	SavedViews,
	VIEW_INPUT,
	VIEW_SOURCES,
	type View,
	ViewSource,
	ViewState,
	Views,
} from "./contract.ts";
import {
	addAnnotation,
	checkedState,
	freeViewId,
	markSent,
	openView,
	readViews,
	removeView,
	ViewStateDoc,
	ViewsDoc,
	viewContext,
} from "./doc.ts";
import { createViewsExtension, type ViewsBackend } from "./tool.ts";

/** The most a selection's data may hold, as JSON: the agent reads it with the view. */
const MAX_SELECTION_DATA = 16 * 1024;

export default defineFacet((host) => {
	contribute(host, "p2.view-tools", (self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const backend = viewsBackend((fn, context) => worker().root(fn, context));
		const extension = createViewsExtension(backend);
		self.contribute(Extensions, { [extension.name]: extension });

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
		const index = self.follow(async (observer, ctx) => {
			const durable = harness().durable;
			const observed = await durable.observeDoc(ViewsDoc, observer, ctx);
			if (observed !== undefined) return observed;
			// No view yet: the document is absent, and an absent address cannot be followed. Create it empty.
			await durable.commit(async (tx) => {
				await tx.doc(ViewsDoc);
			}, ctx);
			return durable.observeDoc(ViewsDoc, observer, ctx);
		});
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
		const doc = self.follow(async (observer, ctx) => {
			const durable = harness().durable;
			const observed = await durable.observeDoc(ViewStateDoc, id, observer, ctx);
			if (observed !== undefined) return observed;
			if (!(await readViews(durable, ctx)).views.some((view) => view.id === id))
				throw invalid("params", `No view "${id}"`);
			await durable.commit(async (tx) => {
				await tx.doc(ViewStateDoc, id, null);
			}, ctx);
			return durable.observeDoc(ViewStateDoc, id, observer, ctx);
		});
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
							(await tx.doc(ViewStateDoc, id, null)).value = checkedState(next);
						}, ctx),
					);
					return null;
				},
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
