// Pages, TUIs and plugins built before a deploy keep working: the providers of `Sessions`, `SessionTree` and `Catalog`
// still bind the versions released before `/tree` and its branch labels, through their `accepts`, and map the current
// state and results back. The old contracts below are copied verbatim from the releases that bundled them
// (`Sessions` v3 and `Catalog` v2 from 0a730c8a7, `Sessions` v4, `Catalog` v3 and `SessionTree` v1 from e88525506,
// `Sessions` v5 from 9ff0ebfd0, `Envs` v1 from 2a32a605a), so their fingerprints are the ones old bundles send.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { arr, bool, int, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	DirectoryListingSchema,
	literal,
	local,
	ModelRefSchema,
	method,
	param,
	propertiesOf,
	remote,
	serverHost,
	sessionHost,
	ThinkingLevelSchema,
} from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Envs, EnvTestSchema, SandboxStatusSchema } from "../../plugins/envs/contract.ts";
import { EnvConfigSchema } from "../../plugins/envs/schema.ts";
import { CreateSchema, MAX_TITLE, type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { bound, boundIn, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const Id = obj({ id: str() });
const Title = str({ minLength: 1, maxLength: MAX_TITLE });

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

/** `Sessions` as 0a730c8a7 declared it. */
const SessionsV3 = remote("p2.sessions", {
	version: 3,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { sessions: arr(SessionSchemaV3), defaultCwd: str(), defaultEnv: union([str(), nul()]) },
			methods: {
				create: method(CreateSchema, SessionSchemaV3),
				relocate: method(obj({ id: str(), cwd: str({ minLength: 1 }), env: union([str(), nul()]) })),
				rename: method(obj({ id: str(), title: Title })),
				pin: method(obj({ id: str(), pinned: bool() })),
				archive: method(Id),
				restore: method(Id),
				clone: method(Id, SessionSchemaV3),
				fork: method(
					obj({ id: str(), conversation: int({ minimum: 1 }), before: int({ minimum: 1 }) }),
					SessionSchemaV3,
				),
			},
		},
		guest: { state: { sessions: arr(SessionSchemaV3) } },
		worker: {
			state: { session: union([SessionSchemaV3, nul()]) },
			methods: {
				renameSelf: method(obj({ title: Title }), obj({ previous: str() })),
				configureSelf: method(obj({ model: opt(ModelRefSchema), thinkingLevel: opt(ThinkingLevelSchema) })),
			},
		},
	},
});

/** `Sessions` as e88525506 declared it. */
const SessionsV4 = remote("p2.sessions", {
	version: 4,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { sessions: arr(SessionSchemaV4), defaultCwd: str(), defaultEnv: union([str(), nul()]) },
			methods: {
				create: method(CreateSchema, SessionSchemaV4),
				relocate: method(obj({ id: str(), cwd: str({ minLength: 1 }), env: union([str(), nul()]) })),
				rename: method(obj({ id: str(), title: Title })),
				pin: method(obj({ id: str(), pinned: bool() })),
				archive: method(Id),
				restore: method(Id),
				clone: method(Id, SessionSchemaV4),
				fork: method(
					obj({ id: str(), conversation: int({ minimum: 1 }), before: int({ minimum: 1 }) }),
					SessionSchemaV4,
				),
			},
		},
		guest: { state: { sessions: arr(SessionSchemaV4) } },
		worker: {
			state: { session: union([SessionSchemaV4, nul()]) },
			methods: {
				renameSelf: method(obj({ title: Title }), obj({ previous: str() })),
				configureSelf: method(obj({ model: opt(ModelRefSchema), thinkingLevel: opt(ThinkingLevelSchema) })),
				treeSelf: method(obj({ main: int({ minimum: 1 }), branches: arr(BranchSchemaV4) })),
			},
		},
	},
});

/** 9ff0ebfd0's `BranchSchema` and `SessionSchema`: a branch label may be null. */
const BranchSchemaV5 = obj({ conversation: int({ minimum: 1 }), label: union([str(), nul()]) });
const SessionSchemaV5 = obj({ ...propertiesOf(SessionSchemaV4), branches: arr(BranchSchemaV5) });

/** `Sessions` as 9ff0ebfd0 declared it (before client-chosen IDs and lifecycle operations). */
const SessionsV5 = remote("p2.sessions", {
	version: 5,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { sessions: arr(SessionSchemaV5), defaultCwd: str(), defaultEnv: union([str(), nul()]) },
			methods: {
				create: method(CreateSchema, SessionSchemaV5),
				relocate: method(obj({ id: str(), cwd: str({ minLength: 1 }), env: union([str(), nul()]) })),
				rename: method(obj({ id: str(), title: Title })),
				pin: method(obj({ id: str(), pinned: bool() })),
				archive: method(Id),
				restore: method(Id),
				clone: method(Id, SessionSchemaV5),
				fork: method(
					obj({ id: str(), conversation: int({ minimum: 1 }), before: int({ minimum: 1 }) }),
					SessionSchemaV5,
				),
			},
		},
		guest: { state: { sessions: arr(SessionSchemaV5) } },
		worker: {
			state: { session: union([SessionSchemaV5, nul()]) },
			methods: {
				renameSelf: method(obj({ title: Title }), obj({ previous: str() })),
				configureSelf: method(obj({ model: opt(ModelRefSchema), thinkingLevel: opt(ThinkingLevelSchema) })),
				treeSelf: method(obj({ main: int({ minimum: 1 }), branches: arr(BranchSchemaV5) })),
			},
		},
	},
});

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

/** `SessionTree` as e88525506 declared it. */
const SessionTreeV1 = remote("p2.tree", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		owner: {
			methods: {
				tree: method(
					undefined,
					obj({
						nodes: arr(
							obj({
								entry: int({ minimum: 1 }),
								parent: union([int({ minimum: 1 }), nul()]),
								role: union([literal("user"), literal("assistant")]),
								text: str(),
							}),
						),
						main: int({ minimum: 1 }),
						current: union([int({ minimum: 1 }), nul()]),
					}),
				),
				navigate: method(
					obj({ entry: int({ minimum: 1 }) }),
					obj({ conversation: int({ minimum: 1 }), text: union([str(), nul()]) }),
				),
				select: method(obj({ conversation: int({ minimum: 1 }) })),
			},
		},
	},
});

/**
 * 2a32a605a's `Envs` (version 1): rows without `users`, `delete` without `force`. Its environment schemas are the
 * current ones, unchanged since that release.
 */
const EnvName = obj({ name: str() });
const EnvKey = obj({ publicKey: str(), identityFile: str() });
const EnvSummarySchemaV1 = obj({ name: str(), config: EnvConfigSchema, sessions: num(), test: opt(EnvTestSchema) });
const EnvsV1 = remote("p2.envs", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { envs: arr(EnvSummarySchemaV1), failure: union([str(), nul()]) },
			methods: {
				list: method(undefined, arr(EnvSummarySchemaV1)),
				warm: method(),
				save: method(obj({ name: str(), config: EnvConfigSchema })),
				delete: method(EnvName),
				test: method(EnvName, EnvTestSchema),
				acceptHostKey: method(obj({ name: str(), lines: arr(str()) })),
				forgetHostKey: method(EnvName),
				generateKey: method(EnvName, EnvKey),
				uploadKey: method(obj({ name: str(), key: str({ maxLength: 16384 }) }), EnvKey),
				publicKey: method(EnvName, union([str(), nul()])),
				listDirectory: method(obj({ env: opt(str()), path: str() }), DirectoryListingSchema),
				sandboxStatus: method(EnvName, SandboxStatusSchema),
				sandboxStart: method(EnvName, SandboxStatusSchema),
				sandboxStop: method(EnvName, SandboxStatusSchema),
			},
		},
	},
});

describe("older contract versions against the current server (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: Session;
	let branch: number;

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace, title: "Versions" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "hello" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: hello"));
		chat.release();
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		status.release();
		// Editing the first message: a new branch labelled "hello"; conversation 1 keeps null (the session title).
		const tree = await holdIn(owner, SessionTree, { session: session.id }, "owner");
		const first = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find((node) => node.role === "user")!;
		branch = (await tree.navigate({ entry: first.entry }, BACKGROUND_CONTEXT)).conversation;
		await until(sessions.sessions, (rows) => rows.some((row) => row.id === session.id && row.branches.length === 2));
		tree.release();
		sessions.release();
	});
	after(async () => {
		await fixture?.close();
	});

	it("binds Sessions v5: rows as they are, create answered with its row", async () => {
		const ref = await boundIn(owner, SessionsV5, {}, "owner");
		const rows = await until(ref.sessions, (list) => list.some((row) => row.id === session.id));
		assert.equal(rows.find((each) => each.id === session.id)?.main, branch);
		const created = await ref.create({ cwd: fixture.workspace, title: "From a v5 tab" }, BACKGROUND_CONTEXT);
		assert.equal(created.title, "From a v5 tab");
		ref.release();
	});

	it("binds Sessions v4: a null branch label reads as the session title", async () => {
		const ref = await boundIn(owner, SessionsV4, {}, "owner");
		const rows = await until(ref.sessions, (list) => list.some((row) => row.id === session.id));
		const row = rows.find((each) => each.id === session.id)!;
		assert.equal(row.main, branch);
		assert.deepEqual(row.branches, [
			{ conversation: branch, label: "hello" },
			{ conversation: 1, label: "Versions" },
		]);
		ref.release();
	});

	it("binds Sessions v3: rows without main and branches, also in method results", async () => {
		const ref = await boundIn(owner, SessionsV3, {}, "owner");
		const rows = await until(ref.sessions, (list) => list.some((row) => row.id === session.id));
		const row = rows.find((each) => each.id === session.id)!;
		assert.equal(row.title, "Versions");
		assert.equal("main" in row || "branches" in row, false);
		const created = await ref.create({ cwd: fixture.workspace, title: "From an old tab" }, BACKGROUND_CONTEXT);
		assert.equal(created.title, "From an old tab");
		assert.equal("main" in created || "branches" in created, false);
		ref.release();
	});

	it("binds SessionTree v1: the tree without labels", async () => {
		const ref = await boundIn(owner, SessionTreeV1, { session: session.id }, "owner");
		const tree = await ref.tree(BACKGROUND_CONTEXT);
		assert.deepEqual(Object.keys(tree).sort(), ["current", "main", "nodes"]);
		assert.equal(tree.main, branch);
		assert.equal(tree.nodes.length, 2, "conversation 1's message and answer");
		for (const node of tree.nodes) assert.deepEqual(Object.keys(node).sort(), ["entry", "parent", "role", "text"]);
		ref.release();
	});

	it("binds Envs v1: rows without users; its delete is never forced", async () => {
		const current = await holdIn(owner, Envs, {}, "owner");
		await current.save({ name: "old-tab", config: { type: "ssh", host: "old.example" } }, BACKGROUND_CONTEXT);
		const ref = await boundIn(owner, EnvsV1, {}, "owner");
		const rows = await until(ref.envs, (list) => list.some((row) => row.name === "old-tab"));
		assert.deepEqual(Object.keys(rows.find((row) => row.name === "old-tab")!).sort(), ["config", "name", "sessions"]);
		await ref.delete({ name: "old-tab" }, BACKGROUND_CONTEXT);
		await until(ref.envs, (list) => !list.some((row) => row.name === "old-tab"));
		ref.release();
		current.release();
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
});
