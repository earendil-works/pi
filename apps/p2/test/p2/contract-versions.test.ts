// Contracts built before a deploy. `Catalog` (local, server plugins) keeps its released versions through its `accepts`:
// a server plugin not reloaded yet binds them and gets the current rows mapped back. Remote contracts restarted as new
// bases when grantable members replaced variants (Chord slice 15): a consumer of a version released before that (a
// page, a TUI or a worker loaded before the deploy) is refused with `contract_mismatch` and reloads. The old `Catalog`
// contracts below are copied verbatim from the releases that bundled them (v2 from 0a730c8a7, v3 from e88525506, v4
// from 0a180b049), so their fingerprints are the ones old bundles send.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { arr, bool, int, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	evolve,
	local,
	ModelRefSchema,
	method,
	propertiesOf,
	remote,
	serverHost,
	ThinkingLevelSchema,
} from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { SESSIONS_OWNER, type Session, SessionSchema, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { bound, type Fixture, failureOf, holdWith, startFixture, until } from "./helpers.ts";

const Id = obj({ id: str() });

/** 0a730c8a7's `SessionSchema`. */
const SessionSchemaV3 = obj({
	id: str(),
	env: opt(union([str(), nul()])),
	cwd: str(),
	title: str(),
	createdAt: num(),
	updatedAt: num(),
	archivedAt: union([num(), nul()]),
	pinned: bool(),
	model: ModelRefSchema,
	thinkingLevel: str(),
});

/** e88525506's `BranchSchema` and `SessionSchema`. */
const BranchSchemaV4 = obj({ conversation: int({ minimum: 1 }), label: str() });
const SessionSchemaV4 = obj({
	id: str(),
	env: opt(union([str(), nul()])),
	cwd: str(),
	title: str(),
	createdAt: num(),
	updatedAt: num(),
	archivedAt: union([num(), nul()]),
	pinned: bool(),
	model: ModelRefSchema,
	thinkingLevel: str(),
	main: int({ minimum: 1 }),
	branches: arr(BranchSchemaV4),
});

/** 9ff0ebfd0's `BranchSchema` and `SessionSchema`: a branch label may be null. */
const BranchSchemaV5 = obj({ conversation: int({ minimum: 1 }), label: union([str(), nul()]) });
const SessionSchemaV5 = obj({ ...propertiesOf(SessionSchemaV4), branches: arr(BranchSchemaV5) });

/** `Catalog` as 0a730c8a7 declared it. */
const CatalogV2 = local("p2.catalog", {
	version: 2,
	params: {},
	members: {
		sessions: arr(SessionSchemaV3),
		get: method(Id, SessionSchemaV3),
		create: method(
			obj({
				id: opt(str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" })),
				env: opt(union([str(), nul()])),
				cwd: str(),
				title: str(),
				titleEdited: opt(bool()),
				model: ModelRefSchema,
				thinkingLevel: ThinkingLevelSchema,
			}),
			SessionSchemaV3,
		),
		activity: method(obj({ id: str(), timestamp: num(), firstUserText: opt(str()) })),
		update: method(
			obj({
				id: str(),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				title: opt(str()),
				pinned: opt(bool()),
				archived: opt(bool()),
				model: opt(ModelRefSchema),
				thinkingLevel: opt(ThinkingLevelSchema),
			}),
			SessionSchemaV3,
		),
	},
});

/** `Catalog` as e88525506 declared it. */
const CatalogV3 = local("p2.catalog", {
	version: 3,
	params: {},
	members: {
		sessions: arr(SessionSchemaV4),
		get: method(Id, SessionSchemaV4),
		create: method(
			obj({
				id: opt(str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" })),
				env: opt(union([str(), nul()])),
				cwd: str(),
				title: str(),
				titleEdited: opt(bool()),
				model: ModelRefSchema,
				thinkingLevel: ThinkingLevelSchema,
			}),
			SessionSchemaV4,
		),
		activity: method(obj({ id: str(), timestamp: num(), firstUserText: opt(str()) })),
		update: method(
			obj({
				id: str(),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				title: opt(str()),
				pinned: opt(bool()),
				archived: opt(bool()),
				model: opt(ModelRefSchema),
				thinkingLevel: opt(ThinkingLevelSchema),
				main: opt(int({ minimum: 1 })),
				branches: opt(arr(BranchSchemaV4)),
			}),
			SessionSchemaV4,
		),
	},
});

/** `Catalog` as 0a180b049 declared it: a branch's label may be null. */
const CatalogV4 = evolve(CatalogV3, (e) =>
	e
		.state("sessions", arr(SessionSchemaV5))
		.result("get", SessionSchemaV5)
		.result("create", SessionSchemaV5)
		.method(
			"update",
			obj({
				id: str(),
				cwd: opt(str()),
				env: opt(union([str(), nul()])),
				title: opt(str()),
				pinned: opt(bool()),
				archived: opt(bool()),
				model: opt(ModelRefSchema),
				thinkingLevel: opt(ThinkingLevelSchema),
				main: opt(int({ minimum: 1 })),
				branches: opt(arr(BranchSchemaV5)),
			}),
			SessionSchemaV5,
		),
);

/** `Sessions` 7, the last version released with variants (declared flat here: no current server binds it). */
const SessionsV7 = remote("p2.sessions", {
	version: 7,
	params: {},
	hostAddress: serverHost,
	state: { sessions: arr(SessionSchema) },
});

describe("older contract versions against the current server (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: Session;
	let branch: number;

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		const sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		session = await sessions.create({ cwd: fixture.workspace, title: "Versions" }, BACKGROUND_CONTEXT);
		const chat = await holdWith(owner, Chat, { session: session.id, conversation: 1 }, ...CHAT_PARTICIPANT);
		await chat.send({ text: "hello", requestId: "hello" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: hello"));
		chat.release();
		const status = await holdWith(owner, SessionStatus, {}, "statuses");
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		status.release();
		// Editing the first message: a new branch labelled "hello"; conversation 1 keeps null (the session title).
		const tree = await holdWith(owner, SessionTree, { session: session.id });
		const first = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find((node) => node.role === "user")!;
		branch = (await tree.navigate({ entry: first.entry }, BACKGROUND_CONTEXT)).conversation;
		await until(sessions.sessions, (rows) => rows.some((row) => row.id === session.id && row.branches.length === 2));
		tree.release();
		sessions.release();
	});
	after(async () => {
		await fixture?.close();
	});

	it("refuses a consumer of a version released with variants: contract_mismatch, and it waits (the page reloads)", async () => {
		const ref = owner.hold(SessionsV7, {}, BACKGROUND_CONTEXT);
		const error = await failureOf(ref);
		assert.equal(error.code, "contract_mismatch");
		assert.equal(ref.state.value.kind === "failed" && ref.state.value.cause.kind, "waiting");
		ref.release();
	});

	it("binds Catalog v2 and v3 on the server", async () => {
		const v2 = await bound(fixture.server.host.hold(CatalogV2, {}, BACKGROUND_CONTEXT));
		assert.equal("branches" in (await v2.get({ id: session.id }, BACKGROUND_CONTEXT)), false);
		v2.release();
		const v3 = await bound(fixture.server.host.hold(CatalogV3, {}, BACKGROUND_CONTEXT));
		assert.deepEqual((await v3.get({ id: session.id }, BACKGROUND_CONTEXT)).branches.at(-1), {
			conversation: 1,
			label: "Versions",
		});
		v3.release();
	});

	it("binds Catalog v4: branches without the conversation they were forked from", async () => {
		// A fork of the edited branch after its first answer (two exchanges: the answer is not the branch's end): its row
		// names the branch as its parent.
		const chat = await holdWith(owner, Chat, { session: session.id, conversation: branch }, ...CHAT_PARTICIPANT);
		for (const text of ["first on the branch", "second on the branch"]) {
			await chat.send({ text, requestId: text }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`));
		}
		chat.release();
		const tree = await holdWith(owner, SessionTree, { session: session.id });
		const answer = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find(
			(node) => node.conversation === branch && node.role === "assistant",
		)!;
		const fork = (await tree.navigate({ entry: answer.entry }, BACKGROUND_CONTEXT)).conversation;
		tree.release();
		const current = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		const rows = await until(current.sessions, (list) =>
			Boolean(list?.find((row) => row.id === session.id)?.branches.some((each) => each.conversation === fork)),
		);
		const branches = rows.find((row) => row.id === session.id)!.branches;
		assert.deepEqual(
			branches.map((each) => [each.conversation, each.parent]),
			[
				[fork, branch],
				// Edited before the first message: a new conversation, forked from none.
				[branch, undefined],
				[1, undefined],
			],
		);
		current.release();
		const withoutParents = branches.map(({ conversation, label }) => ({ conversation, label }));
		const v4 = await bound(fixture.server.host.hold(CatalogV4, {}, BACKGROUND_CONTEXT));
		assert.deepEqual((await v4.get({ id: session.id }, BACKGROUND_CONTEXT)).branches, withoutParents);
		v4.release();
	});
});
