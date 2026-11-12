// Views (worker): the session's views and annotations as browsers hold them (`Views`), the agent's view tools, and the
// send router that adds what the person selected and annotated (and what other plugins add, `MessageContexts`) to
// their next message.
import type { Tx } from "@earendil-works/pi-durable";
import {
	type Author,
	authorOf,
	type Ctx,
	canSend,
	canView,
	contribute,
	DEFAULT_OWNER_NAME,
	defineFacet,
	deriveTyped,
	forbidden,
	invalid,
	isGuest,
	isOwner,
	type MessageData,
	type Self,
	serveKeyed,
} from "@p2/app/v1";
import { Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { Conversation, SendRouters } from "../chat/contract.ts";
import { Attachments, MAX_ATTACHMENTS } from "../files/contract.ts";
import { WorkerModels } from "../models/contract.ts";
import { liveViews, type MessageContext, MessageContexts, VIEW_INPUT, VIEWS_ACCEPTS, Views } from "./contract.ts";
import {
	addAnnotation,
	freeViewId,
	markSent,
	openView,
	readViews,
	removeView,
	selectInline,
	ViewsDoc,
	viewContext,
} from "./doc.ts";
import { createViewsExtension } from "./tool.ts";

/** The most a selection's data may hold, as JSON: the agent reads it with `view_list`. */
const MAX_SELECTION_DATA = 16 * 1024;

export default defineFacet((host) => {
	serveKeyed(host, MessageContexts);
	contribute(host, "p2.view-tools", (self) => {
		const harness = harnessOf(self);
		const extension = createViewsExtension();
		self.contribute(Extensions, { [extension.name]: extension });
		const contexts = self.registry(MessageContexts);

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
		// A message with new selections, annotations or other plugins' context carries them after its text (the model's
		// copy only: the transcript shows what the person wrote, and a note). Others go on to the next router, or become
		// plain inputs.
		self.contribute(SendRouters, {
			views: async ({ conversation, author, text, requestId, whenBusy, attachments }, ctx) => {
				const durable = harness().durable;
				const carried = viewContext(await readViews(durable, ctx));
				const others: MessageContext[] = [];
				for (const context of contexts.value.values()) {
					const added = await context(ctx);
					if (added) others.push(added);
				}
				if (!carried && !others.length) return undefined;
				const files = attachments.length ? await resolve(attachments, conversation, ctx) : [];
				const data: MessageData & {
					views: { selections: number; annotations: number; notes?: string[] };
				} = {
					author,
					text,
					attachments: files.map(({ id, name }) => ({ id, name })),
					views: {
						selections: (carried?.selections.length ?? 0) + (carried?.inline.length ?? 0),
						annotations: carried?.annotations.length ?? 0,
						...(others.length ? { notes: others.map((other) => other.note) } : {}),
					},
				};
				const blocks = [...(carried ? [carried.text] : []), ...others.map((other) => other.text)].join("\n\n");
				const chat = await ctx.get(Conversation, { conversation });
				const submitted = await chat.submit(
					{
						text: text.trim() ? `${text}\n\n${blocks}` : blocks,
						requestId,
						author,
						files,
						entry: { kind: VIEW_INPUT, data },
						...(whenBusy ? { whenBusy } : {}),
					},
					ctx,
				);
				if (carried) await durable.commit(async (tx) => markSent(await tx.doc(ViewsDoc), carried), ctx);
				for (const other of others) await other.carried(ctx);
				return submitted;
			},
		});
	});

	host.serve(
		Views,
		({ session }, principal, self) => {
			if (!canView(principal, session)) throw forbidden("viewers only");
			const harness = harnessOf(self);
			const worker = workerOf(self);
			const index = followViews(self);
			const views = deriveTyped(self, [index], ([value]) => liveViews(value));
			const annotations = deriveTyped(self, [index], ([value]) => value.annotations);
			const arrangement = deriveTyped(self, [index], ([value]) => value.arrangement ?? null);
			const inline = deriveTyped(self, [index], ([value]) => value.inline ?? []);
			if (!canSend(principal, session) || (!isOwner(principal) && !isGuest(principal)))
				return { variant: "reader", members: { views, annotations, arrangement, inline } };
			const person = principal;
			const settings = self.get(WorkerModels, {});
			const author = (): Author => authorOf(person, settings.settings.value.ownerName ?? DEFAULT_OWNER_NAME);
			/** A person's call: refused while the session moves, which waits for running calls (as the chat's). */
			const call = <T>(fn: () => Promise<T>): Promise<T> => worker().liveness.call(fn);
			const commit = <T>(change: (draft: Awaited<ReturnType<typeof viewsDraft>>) => T, ctx: Ctx): Promise<T> =>
				call(() => harness().durable.commit(async (tx) => change(await viewsDraft(tx)), ctx));
			return {
				variant: "editor",
				members: {
					views,
					annotations,
					arrangement,
					inline,
					open: ({ kind, item, title: given }, ctx) =>
						call(async () => {
							if (kind === "markdown" && !item) throw invalid("args", "A markdown view needs a file");
							const durable = harness().durable;
							const title =
								given ||
								(kind === "changes" ? (item ? `Changes in ${item}` : "Changes") : (item ?? kind)).slice(0, 120);
							const id = freeViewId(await readViews(durable, ctx), title, kind);
							const view = await durable.commit(
								(tx) => openView(tx, { id, kind, title, ...(item ? { item } : {}) }, Date.now()),
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
					selectInline: async (input, ctx) => {
						if (JSON.stringify(input.selection?.data ?? null).length > MAX_SELECTION_DATA)
							throw invalid("args", "Selection data is too large");
						await commit((draft) => selectInline(draft, input), ctx);
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
							for (const each of draft.inline ?? []) each.selection.sent = true;
						}, ctx);
						return null;
					},
				},
			};
		},
		{ accepts: VIEWS_ACCEPTS },
	);
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

/** The views document's draft in `tx`. */
const viewsDraft = (tx: Tx) => tx.doc(ViewsDoc);
