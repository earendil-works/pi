// The object of the stored-data proof: it owns the persisted documents, the tables and the job of `declarations.ts`,
// writes them (`write-stored.ts`, with the TypeBox helpers) and reads them back (the test, after the switch).

import type { Context } from "../../../src/context/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import type { TableDefinition } from "../../../src/next/store/index.ts";
import { openStore, query, type Store, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { ImportJob, Notes, Owner, Profile, Rows } from "./declarations.ts";

/** What the job's `run` does in this process: wait until its context ends, or finish at once. */
export type RunBehaviour = "wait" | "finish";

/** The finished runs' results, in order. */
export const finished: unknown[] = [];

/** The owner's facet over `edits` (the table version this process declares). */
export function ownerFacet(edits: TableDefinition, behaviour: RunBehaviour) {
	return defineFacet((host) => {
		host.serve(Owner, (_, self) => {
			const profile = self.state(Profile);
			const notes = self.state(Notes);
			const rows = self.table(Rows);
			const editsTable = self.table(edits);
			const imports = self.job(ImportJob, {
				run: async ({ path }, ctx) => {
					await ctx.state.change((draft) => {
						draft.done += path.length;
					}, ctx);
					if (behaviour === "wait") {
						await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
					}
					return { count: ctx.state.value.done };
				},
				finish: async (outcome) => {
					finished.push(outcome.kind === "done" ? outcome.result : outcome.kind);
				},
			});
			return {
				profile,
				write: async ({ id, body }, ctx) => {
					await self.tx(async (tx) => {
						(await tx.draft(notes, id)).body = body;
						const draft = await tx.draft(profile);
						draft.count += 1;
						draft.tags.push(id);
						draft.extra[id] = body.length;
						draft.choice = { deep: [{ x: draft.count }] };
						draft.nested = { inner: { v: body } };
						tx.put(rows, {
							id,
							label: body,
							data: { a: body.length, b: [id] },
							...(id === "a" ? { maybe: { n: 1.5 } } : {}),
						});
						tx.put(editsTable, { id, file: `/notes/${id}.md`, at: body.length } as never);
					}, ctx);
					await imports.start({ path: id }, ctx);
					return null;
				},
				read: async (id, ctx) => (await notes.get(id, ctx))?.body ?? "",
				dump: async (_, ctx) => ({
					profile: profile.value,
					notes: { a: (await notes.get("a", ctx)) ?? null, b: (await notes.get("b", ctx)) ?? null },
					rows: (await rows.page(query(Rows), 10, ctx)).items,
					edits: (await editsTable.page(query(edits as TableDefinition), 10, ctx)).items,
					runs: imports.running.value.length,
				}),
			};
		});
	});
}

/** A host serving the owner on the SQLite store at `path`. */
export async function ownerHost(
	path: string,
	edits: TableDefinition,
	behaviour: RunBehaviour,
	context: Context,
): Promise<{ store: Store; host: Host }> {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const host = createHost({ store, onError: () => {}, closeTimeout: 100 });
	await host.load([{ name: "@fixture/owner", facet: ownerFacet(edits, behaviour) }], context);
	return { store, host };
}
