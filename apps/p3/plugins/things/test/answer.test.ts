// `MyAnswer` (`answer.ts`): a caller's answer for one thing, for admissions off the server. A person asks about
// themselves only, a session's worker about anyone in its own session's workspace, the server about anyone; the answer
// is live (a grant changes it at once) and `null` when nothing is given.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type P3Principal, type Reference, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { ThingsStore } from "../contract.server.ts";
import { MyAnswer, type Source } from "../contract.ts";
import { WorkspaceKind } from "../workspaces.ts";
import { Board } from "./kinds.ts";
import { type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

let w: World;
let store: Reference<typeof ThingsStore>;
let space: string;
let board: string;
let ann: string;

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	const pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
	space = await store.createWorkspace({ kind: WorkspaceKind.name, name: "s", parent: pi, by: BY }, context);
	board = await store.create({ kind: Board.name, name: "b", workspace: space, by: BY }, context);
	ann = await store.createPerson({ name: "Ann", madeBy: BY }, context);
});

afterEach(() => w.close(context));

/** `MyAnswer` for `caller` on the board, held as `principal` for `fn`. */
function asking<T>(principal: P3Principal, caller: string, fn: (ref: Reference<typeof MyAnswer>) => Promise<T>) {
	return w.host.root(
		async (ctx) => fn(await ctx.get(MyAnswer, { workspace: space, thing: board, caller }, { readyTimeout: 1000 })),
		context,
		{ principal },
	);
}

const ANN = (): P3Principal => ({ kind: "person", id: ann, name: "Ann" });

describe("MyAnswer", () => {
	it("is null while nothing is given, and follows a grant live", async () => {
		await asking(ANN(), `person:${ann}`, async (ref) => {
			assert.equal(ref.answer.value, null);
			await store.putParty({ workspace: space, party: { kind: "person", person: ann }, source: BY }, context);
			// Present: the board's default grant for everyone here (Read) is hers.
			const given = await until(ref.answer, (value) => value !== null, within("the grant", context));
			assert.deepEqual(given?.ticks, ["read"]);
		});
	});

	it("answers a person about themselves only, a worker about its own session's workspace only", async () => {
		await assert.rejects(
			asking(ANN(), "person:bob", async () => null),
			/about the caller only/,
		);
		const own: P3Principal = { kind: "worker", session: space };
		assert.equal(await asking(own, `person:${ann}`, async (ref) => ref.answer.value), null);
		const other: P3Principal = { kind: "worker", session: "other" };
		await assert.rejects(
			asking(other, `person:${ann}`, async () => null),
			/about the caller only/,
		);
	});
});
