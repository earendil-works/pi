// Pages, TUIs, workers and plugins built before a deploy keep working: the providers of `Sessions`, `SessionTree`,
// `Catalog`, `Envs`, `SessionStatus` and `Subagents` still bind the versions released before, through their `accepts`,
// and map the current state, arguments and results between versions. The old contracts below are copied verbatim from
// the releases that bundled them (`Sessions` v3 and `Catalog` v2 from 0a730c8a7, `Sessions` v4, `Catalog` v3 and
// `SessionTree` v1 from e88525506, `Sessions` v5 from 9ff0ebfd0, `Catalog` v4 from 0a180b049, `Sessions` v6 from
// 20d86c365, `Envs` v1 from 2a32a605a and v2 from d07548004, `SessionStatus` v1 and `Subagents` v2 from 6e11a00a0), so
// their fingerprints are the ones old bundles send.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { arr, bool, int, nul, num, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	DirectoryListingSchema,
	evolve,
	LocationSchema,
	literal,
	local,
	ModelRefSchema,
	method,
	param,
	propertiesOf,
	record,
	remote,
	serverHost,
	sessionHost,
	ThinkingLevelSchema,
	unsafe,
} from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Envs, EnvTestSchema, SandboxStatusSchema } from "../../plugins/envs/contract.ts";
import { SandboxMountSchema, SshEnvConfigSchema } from "../../plugins/envs/schema.ts";
import { CreateSchema, MAX_TITLE, type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
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

/** 20d86c365's `SessionIdSchema`, `CreateArgsSchema` and `OperationSchema`. */
const SessionIdSchemaV6 = str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const CreateArgsSchemaV6 = obj({ ...propertiesOf(CreateSchema), id: opt(SessionIdSchemaV6) });
const OperationKindSchemaV6 = union([literal("relocate"), literal("clone"), literal("fork"), literal("archive")]);
const OperationSchemaV6 = union([
	obj({
		phase: literal("running"),
		id: str(),
		kind: OperationKindSchemaV6,
		session: str(),
		target: union([str(), nul()]),
		copying: bool(),
	}),
	obj({
		phase: literal("failed"),
		id: str(),
		kind: OperationKindSchemaV6,
		session: str(),
		target: union([str(), nul()]),
		error: str(),
	}),
]);

/** `Sessions` as 20d86c365 declared it. */
const SessionsV6 = evolve(SessionsV5, (e) =>
	e
		.args("create", CreateArgsSchemaV6)
		.args("clone", obj({ id: str(), copy: opt(SessionIdSchemaV6) }))
		.args(
			"fork",
			obj({
				id: str(),
				conversation: int({ minimum: 1 }),
				before: int({ minimum: 1 }),
				copy: opt(SessionIdSchemaV6),
			}),
		)
		.addState("owner", "operations", arr(OperationSchemaV6))
		.addMethod("owner", "dismissOperation", obj({ operation: str() }), nul()),
);

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

/** The environment configuration of `Envs` v1 and v2: sandboxes without `diskGb` (the SSH schema is unchanged). */
const EnvConfigSchemaV2 = union([
	SshEnvConfigSchema,
	obj({
		type: literal("gondolin"),
		host: str({ minLength: 1, maxLength: 32 }),
		image: opt(str({ minLength: 1, maxLength: 255 })),
		mounts: opt(arr(SandboxMountSchema, { maxItems: 16 })),
		allowHosts: opt(arr(str({ minLength: 1, maxLength: 255 }), { maxItems: 256 })),
		cpus: opt(int({ minimum: 1, maximum: 64 })),
		memoryMb: opt(int({ minimum: 256, maximum: 262144 })),
	}),
]);

/** 2a32a605a's `Envs` (version 1): rows without `users`, `delete` without `force`. */
const EnvName = obj({ name: str() });
const EnvKey = obj({ publicKey: str(), identityFile: str() });
const EnvSummarySchemaV1 = obj({ name: str(), config: EnvConfigSchemaV2, sessions: num(), test: opt(EnvTestSchema) });
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
				save: method(obj({ name: str(), config: EnvConfigSchemaV2 })),
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

/** d07548004's `Envs` (version 2): rows with `users`, `delete` with `force`, sandboxes without `diskGb`. */
const EnvsV2 = evolve(EnvsV1, (e) =>
	e
		.state(
			"owner",
			"envs",
			arr(
				obj({
					name: str(),
					config: EnvConfigSchemaV2,
					sessions: num(),
					users: opt(arr(obj({ id: str(), title: str(), main: num(), archived: bool() }))),
					test: opt(EnvTestSchema),
				}),
			),
		)
		.result(
			"list",
			arr(
				obj({
					name: str(),
					config: EnvConfigSchemaV2,
					sessions: num(),
					users: opt(arr(obj({ id: str(), title: str(), main: num(), archived: bool() }))),
					test: opt(EnvTestSchema),
				}),
			),
		)
		.args("delete", obj({ name: str(), force: opt(bool()) })),
);

/** 6e11a00a0's `StatusSchema`, `StatusesSchema` and `ReportFields`: no per-conversation work. */
const StatusSchemaV1 = obj({
	/** A worker process runs for the session. */
	running: bool(),
	error: opt(str()),
	usage: opt(unsafe<Usage>(unknown())),
	/** Live Durable tasks (foreground and background). */
	tasks: num(),
	/** Conversations with foreground work, ascending. */
	busy: arr(num()),
});
const StatusesSchemaV1 = record(StatusSchemaV1);
const ReportFieldsV1 = {
	tasks: num(),
	busy: arr(num()),
	usage: opt(unsafe<Usage>(unknown())),
};
const ReportSchemaV1 = obj(ReportFieldsV1);

/** `SessionStatus` as 6e11a00a0 declared it. */
const SessionStatusV1 = remote("p2.session-status", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { statuses: StatusesSchemaV1 } },
		reporter: { methods: { report: method(ReportSchemaV1) } },
	},
});

/** 6e11a00a0's `ChildSchema`: no time or failure. */
const ChildSchemaV2 = obj({
	/** A subagent's name; a one-shot agent's label. */
	name: str(),
	/** `agent`: a code mode script's one-shot agent, read-only and listed on the script's tool card, not the sidebar. */
	kind: opt(literal("agent")),
	/** A one-shot agent's nested call ID (`<script call ID>/c<n>`), as the script's tool card lists it. */
	callId: opt(str()),
	/** An archived subagent: hidden in the sidebar's archived row; still usable. */
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	/** A subagent's own location (environment and cwd, e.g. a git worktree); absent: it follows the session. */
	location: opt(LocationSchema),
	lastEntryId: num(),
});
const ChildrenSchemaV2 = record(arr(ChildSchemaV2));

/** `Subagents` as 6e11a00a0 declared it. */
const SubagentsV2 = remote("p2.subagents", {
	// 2: a child's own location instead of its own cwd.
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { children: ChildrenSchemaV2 } },
		reporter: { methods: { report: method(obj({ children: arr(ChildSchemaV2) })) } },
	},
});

/** The fields a status and a child had in the released versions (the current ones add more). */
const STATUS_KEYS_V1 = new Set(["running", "error", "usage", "tasks", "busy"]);
const CHILD_KEYS_V2 = new Set([
	"name",
	"kind",
	"callId",
	"archived",
	"conversationId",
	"model",
	"thinkingLevel",
	"tools",
	"location",
	"lastEntryId",
]);
const added = (value: object, released: ReadonlySet<string>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(value).filter(([key]) => !released.has(key)));
const texts = (view: ConversationView | null | undefined): string[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		),
	);

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

	const workerGeneration = (id: string): Promise<number> =>
		fixture.server.host.root(async (ctx) => {
			const generation = (await ctx.get(Hosts, {})).workers.value[id]?.generation;
			assert(generation !== undefined, `no worker for ${id}`);
			return generation;
		}, BACKGROUND_CONTEXT);

	it("binds Sessions v5: rows without a branch's parent, create answered with its row", async () => {
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

	it("binds Envs v2: rows with users, sandboxes without a disk size", async () => {
		const current = await holdIn(owner, Envs, {}, "owner");
		await current.save({ name: "v2-host", config: { type: "ssh", host: "v2.example" } }, BACKGROUND_CONTEXT);
		await current.save(
			{ name: "v2-box", config: { type: "gondolin", host: "v2-host", diskGb: 8 } },
			BACKGROUND_CONTEXT,
		);
		const ref = await boundIn(owner, EnvsV2, {}, "owner");
		const rows = await until(ref.envs, (list) => list.some((row) => row.name === "v2-box"));
		assert.deepEqual(rows.find((row) => row.name === "v2-box")?.config, { type: "gondolin", host: "v2-host" });
		assert(Array.isArray(rows.find((row) => row.name === "v2-box")?.users));
		await current.delete({ name: "v2-box" }, BACKGROUND_CONTEXT).catch(() => {});
		ref.release();
		current.release();
	});

	it("binds SessionStatus v1 as a reader: statuses without per-conversation work", async () => {
		const current = await holdIn(owner, SessionStatus, {}, "reader");
		const now = await until(current.statuses, (value) => value?.[session.id]?.running === true);
		assert.notDeepEqual(added(now[session.id]!, STATUS_KEYS_V1), {}, "the current status has more fields");
		const ref = await boundIn(owner, SessionStatusV1, {}, "reader");
		const statuses = await until(ref.statuses, (value) => value?.[session.id]?.running === true);
		assert.deepEqual(added(statuses[session.id]!, STATUS_KEYS_V1), {});
		assert.equal(statuses[session.id]!.tasks, 0);
		ref.release();
		current.release();
	});

	it("binds SessionStatus v1 as a worker: its report is accepted, with no conversation's work", async () => {
		// The open chat keeps the session's worker running, so a report of its generation counts.
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const current = await holdIn(owner, SessionStatus, {}, "reader");
		await until(current.statuses, (value) => value?.[session.id]?.running === true);
		const generation = await workerGeneration(session.id);
		const worker = await boundIn(
			fixture.as({ kind: "worker", session: session.id, generation }),
			SessionStatusV1,
			{},
			"reporter",
		);
		await worker.report({ tasks: 4, busy: [9, 2] }, BACKGROUND_CONTEXT);
		const statuses = await until(current.statuses, (value) => value?.[session.id]?.tasks === 4);
		const { running, tasks, busy, ...rest } = statuses[session.id]!;
		assert.deepEqual({ running, tasks, busy }, { running: true, tasks: 4, busy: [2, 9] });
		// The field version 2 adds (each busy conversation's work) is empty.
		assert.deepEqual(Object.values(added(rest, STATUS_KEYS_V1)), [{}]);
		await worker.report({ tasks: 0, busy: [] }, BACKGROUND_CONTEXT);
		await until(current.statuses, (value) => value?.[session.id]?.tasks === 0);
		worker.release();
		current.release();
		chat.release();
	});

	it("binds Subagents v2 as a reader and a worker: children without time and failure", async () => {
		// The main conversation is the edited branch (conversation 1 is an earlier one, read-only).
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: branch }, "participant");
		const current = await holdIn(owner, Subagents, {}, "reader");
		await chat.send({ text: "subagent", requestId: "subagent" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) =>
			texts(view).some(
				(text) => text.startsWith("[answered, no reply needed]") && text.includes("Echo: hello helper"),
			),
		);
		const listed = await until(current.children, (value) =>
			Boolean(value?.[session.id]?.some((child) => Object.keys(added(child, CHILD_KEYS_V2)).length > 0)),
		);
		const child = listed[session.id]!.find((each) => each.name === "helper")!;
		const reader = await boundIn(owner, SubagentsV2, {}, "reader");
		const old = await until(reader.children, (value) => value?.[session.id]?.length === 1);
		assert.deepEqual(old[session.id], [
			Object.fromEntries(Object.entries(child).filter(([key]) => CHILD_KEYS_V2.has(key))),
		]);
		reader.release();
		// A worker built then reports its children without the new fields; they read as absent.
		const generation = await workerGeneration(session.id);
		const worker = await boundIn(
			fixture.as({ kind: "worker", session: session.id, generation }),
			SubagentsV2,
			{},
			"reporter",
		);
		const reported = { ...old[session.id]![0]!, name: "from-v2" };
		await worker.report({ children: [reported] }, BACKGROUND_CONTEXT);
		const replaced = await until(current.children, (value) => value?.[session.id]?.[0]?.name === "from-v2");
		assert.deepEqual(replaced[session.id], [reported]);
		worker.release();
		current.release();
		chat.release();
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

	it("binds Sessions v6, v5 and Catalog v4: branches without the conversation they were forked from", async () => {
		// A fork of the edited branch after its first answer: its row names the branch as its parent.
		const tree = await holdIn(owner, SessionTree, { session: session.id }, "owner");
		const answer = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find(
			(node) => node.conversation === branch && node.role === "assistant",
		)!;
		const fork = (await tree.navigate({ entry: answer.entry }, BACKGROUND_CONTEXT)).conversation;
		tree.release();
		const current = await holdIn(owner, Sessions, {}, "owner");
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
		const withoutParents = branches.map(({ conversation, label }) => ({ conversation, label }));
		const ref = await boundIn(owner, SessionsV6, {}, "owner");
		const old = await until(ref.sessions, (list) =>
			Boolean(list?.find((row) => row.id === session.id)?.branches.length === 3),
		);
		assert.deepEqual(old.find((row) => row.id === session.id)!.branches, withoutParents);
		assert(Array.isArray(await until(ref.operations, (list) => list !== undefined)));
		ref.release();
		const v5 = await boundIn(owner, SessionsV5, {}, "owner");
		const listed = await until(v5.sessions, (list) =>
			Boolean(list?.find((row) => row.id === session.id)?.branches.length === 3),
		);
		assert.deepEqual(listed.find((row) => row.id === session.id)!.branches, withoutParents);
		v5.release();
		current.release();
		const v4 = await bound(fixture.server.host.hold(CatalogV4, {}, BACKGROUND_CONTEXT));
		assert.deepEqual((await v4.get({ id: session.id }, BACKGROUND_CONTEXT)).branches, withoutParents);
		v4.release();
	});
});
