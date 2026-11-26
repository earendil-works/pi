// Project coordinators (plugins/projects): a project's coordinator session, made once on the first open at the project's
// default place and joined to it (the same session after a failed make), restored when archived, owner-only; its
// worker's tools and prompt section (the project's current name, from `CoordinatedProject`, workers only), other
// sessions keep theirs, a former coordinator and a copy of one get theirs back; it follows a rename, stays in its
// project, is archived and restored with it (also when the project is archived or deleted while it is being made) and
// archived when the project is deleted; the conversations tool starts its sessions in its project (with a cwd too) and
// lists that project's sessions first; `ProjectService` 2 is still served.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import { arr, nul, num, obj, str, union } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, local, method, record, whenLive } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { ConversationBroker, type Query } from "../../plugins/conversations/contract.ts";
import {
	COORDINATOR_TITLE,
	CoordinatedProject,
	ProjectCoordinators,
	Projects,
} from "../../plugins/projects/contract.ts";
import { SESSIONS_OWNER, Sessions, type SessionsOwner } from "../../plugins/sessions/contract.ts";
import type { Host, Ref } from "../../src/runtime/chord.ts";
import { bound, expectChord, type Fixture, holdWith, startFixture, until } from "./helpers.ts";

const agentOf = (view: ConversationView | null | undefined) => view?.docs["pi.agent"] as AgentState | undefined;

/** The prompt sections in effect at the end of a conversation's view: its system messages replayed in order. */
function sections(view: ConversationView | null | undefined): Record<string, string> {
	const current: Record<string, string> = {};
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system") continue;
			for (const [key, value] of Object.entries(message.sections ?? {})) {
				if (value === null) delete current[key];
				else current[key] = value;
			}
		}
	return current;
}

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "conversations",
		),
	);

describe("project coordinators", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: SessionsOwner;
	let projects: Ref<typeof Projects>;
	let coordinators: Ref<typeof ProjectCoordinators>;
	let coordinator: string;
	const row = (id: string) => sessions.sessions.value?.find((each) => each.id === id);
	const broker = (source: string, requestId: string, query: Query) =>
		fixture.server.host.root(
			async (ctx) => (await ctx.get(ConversationBroker, {})).query({ source, requestId, query }, ctx),
			BACKGROUND_CONTEXT,
		);
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		projects = await holdWith(owner, Projects, {});
		coordinators = await holdWith(owner, ProjectCoordinators, {});
		await projects.create({ name: "app", place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await projects.create({ name: "other", place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.length === 2);
	});
	after(() => fixture?.close());

	it("is owner-only", async () => {
		const guest = fixture
			.as({ kind: "guest", id: "guest", name: "Guest", home: "unknown", sessions: { unknown: "full" }, revision: 1 })
			.hold(ProjectCoordinators, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(guest), "forbidden");
		guest.release();
	});

	it("is made once on the first open, at the default place, in its project; restored when archived", async () => {
		assert.deepEqual(await until(coordinators.sessions, (value) => value !== undefined), {});
		const [first, second] = await Promise.all([
			coordinators.open({ name: "app" }, BACKGROUND_CONTEXT),
			coordinators.open({ name: "app" }, BACKGROUND_CONTEXT),
		]);
		assert.equal(first.id, second.id, "concurrent opens make one session");
		coordinator = first.id;
		assert.deepEqual(await until(coordinators.sessions, (value) => value?.app === coordinator), { app: coordinator });
		await until(sessions.sessions, () => row(coordinator) !== undefined);
		assert.deepEqual([row(coordinator)?.cwd, row(coordinator)?.title], [fixture.workspace, COORDINATOR_TITLE]);
		assert.equal(
			await until(projects.sessions, (map) => map?.[coordinator] === "app").then((map) => map[coordinator]),
			"app",
		);
		await sessions.archive({ id: coordinator }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(coordinator)?.archivedAt !== null);
		assert.equal((await coordinators.open({ name: "app" }, BACKGROUND_CONTEXT)).id, coordinator);
		await until(sessions.sessions, () => row(coordinator)?.archivedAt === null);
		await assert.rejects(coordinators.open({ name: "nope" }, BACKGROUND_CONTEXT), /No project "nope"/);
	});

	it("only orchestrates, with its project in its prompt; other sessions keep their tools", async () => {
		const chat = await holdWith(owner, Chat, { session: coordinator, conversation: 1 }, ...CHAT_PARTICIPANT);
		const tools = ["conversations", "codemode", "history_search", "history_read", "history_handoff"];
		const agent = agentOf(await until(chat.view, (view) => Array.isArray(agentOf(view)?.modelTools)));
		assert.deepEqual([agent?.modelTools, agent?.tools], [tools, tools]);
		await chat.send({ text: "hello coordinator", requestId: "hello" }, BACKGROUND_CONTEXT);
		const answered = await until(chat.view, (view) => JSON.stringify(view).includes("Echo: hello coordinator"));
		assert.match(sections(answered)["project-coordinator"] ?? "", /coordinator of the project "app"/);
		chat.release();

		const other = (await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT)).id;
		const otherChat = await holdWith(owner, Chat, { session: other, conversation: 1 }, ...CHAT_PARTICIPANT);
		await otherChat.send({ text: "hello other", requestId: "other" }, BACKGROUND_CONTEXT);
		const view = await until(otherChat.view, (value) => JSON.stringify(value).includes("Echo: hello other"));
		assert.equal(agentOf(view)?.tools, undefined);
		assert.equal(sections(view)["project-coordinator"], undefined);
		otherChat.release();
	});

	it("starts sessions in its project without naming it, and lists its project first", async () => {
		const chat = await holdWith(owner, Chat, { session: coordinator, conversation: 1 }, ...CHAT_PARTICIPANT);
		const count = results(await until(chat.view, Boolean)).length;
		const query = { action: "create", title: "Work", message: "do the work" };
		await chat.send({ text: `conversations ${JSON.stringify(query)}`, requestId: "create" }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(value) => results(value).length > count && !(value?.docs["pi.live"] as { run?: unknown })?.run,
		);
		assert.equal(results(view).at(-1)?.isError, false);
		chat.release();
		const work = await until(sessions.sessions, (list) => Boolean(list?.some((each) => each.title === "Work")));
		const created = work.find((each) => each.title === "Work")!;
		assert.equal(created.cwd, fixture.workspace);
		assert.equal(
			await until(projects.sessions, (map) => map?.[created.id] === "app").then((map) => map[created.id]),
			"app",
		);

		// The session without a project made earlier comes after the coordinator's own.
		const listed = await broker(coordinator, "list", { action: "list" });
		assert.ok(listed.action === "list");
		const order = listed.peers.map((peer) => peer.project ?? null);
		const firstElsewhere = order.findIndex((project) => project !== "app");
		assert.ok(firstElsewhere > 0 && order.slice(firstElsewhere).every((project) => project !== "app"));
		// Any other session still names a project or a folder.
		await assert.rejects(
			broker(created.id, "neither", { action: "create", message: "x" }),
			/create needs either a project or a cwd/,
		);
	});

	it("starts sessions in a folder in its project too, and at the default place on its machine", async () => {
		const sub = join(fixture.workspace, "sub");
		mkdirSync(sub, { recursive: true });
		const inFolder = await broker(coordinator, "in-folder", { action: "create", cwd: sub, message: "in a folder" });
		assert.ok(inFolder.action === "create" && inFolder.cwd === sub && inFolder.env === null);
		assert.equal((await until(projects.sessions, (map) => map?.[inFolder.to] === "app"))[inFolder.to], "app");
		// A default place on another machine: the session starts there, not on this device.
		await projects.locate({ name: "app", place: { env: "gpu", path: "~/app" } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.find((each) => each.name === "app")?.places[0]?.env === "gpu");
		await assert.rejects(broker(coordinator, "remote", { action: "create", message: "remote" }), /gpu/);
		await projects.locate({ name: "app", place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.find((each) => each.name === "app")?.places[0]?.env === null);
	});

	it("follows a rename and stays in its project", async () => {
		await projects.rename({ name: "app", to: "site" }, BACKGROUND_CONTEXT);
		assert.deepEqual(await until(coordinators.sessions, (value) => value?.site === coordinator), {
			site: coordinator,
		});
		await assert.rejects(
			projects.assign({ session: coordinator, project: "other" }, BACKGROUND_CONTEXT),
			/coordinator of "site" stays in its project/,
		);
		await assert.rejects(
			projects.assign({ session: coordinator, project: null }, BACKGROUND_CONTEXT),
			/stays in its project/,
		);
		await projects.assign({ session: coordinator, project: "site" }, BACKGROUND_CONTEXT);
		const chat = await holdWith(owner, Chat, { session: coordinator, conversation: 1 }, ...CHAT_PARTICIPANT);
		await chat.send({ text: "after rename", requestId: "renamed" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => JSON.stringify(value).includes("Echo: after rename"));
		assert.match(sections(view)["project-coordinator"] ?? "", /coordinator of the project "site"/);
		chat.release();
		// Its sessions join the project by its new name.
		const created = await broker(coordinator, "after-rename", { action: "create", message: "renamed" });
		assert.ok(created.action === "create");
		assert.equal((await until(projects.sessions, (map) => map?.[created.to] === "site"))[created.to], "site");
	});

	it("tells only workers which project they coordinate", async () => {
		const held = owner.hold(CoordinatedProject, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(held), "forbidden");
		held.release();
	});

	it("is archived and restored with its project, and archived when the project is deleted", async () => {
		await projects.archive({ name: "site" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(coordinator)?.archivedAt !== null);
		await assert.rejects(coordinators.open({ name: "site" }, BACKGROUND_CONTEXT), /Project "site" is archived/);
		await projects.restore({ name: "site" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(coordinator)?.archivedAt === null);

		await projects.remove({ name: "site" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(coordinator)?.archivedAt !== null);
		assert.deepEqual(await until(coordinators.sessions, (value) => value?.site === undefined), {});
		// A new project of the same name gets a new coordinator.
		await projects.create({ name: "site", place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => Boolean(list?.some((project) => project.name === "site")));
		assert.notEqual((await coordinators.open({ name: "site" }, BACKGROUND_CONTEXT)).id, coordinator);
	});

	it("makes the same session after a failed make", async () => {
		const place = join(fixture.workspace, "later");
		await projects.create({ name: "later", place: { env: null, path: place } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => Boolean(list?.some((project) => project.name === "later")));
		// Its folder does not exist yet: the ID is chosen and joined, the session not made.
		await assert.rejects(coordinators.open({ name: "later" }, BACKGROUND_CONTEXT));
		const chosen = (await until(coordinators.sessions, (map) => map?.later !== undefined)).later!;
		assert.equal(row(chosen), undefined);
		mkdirSync(place, { recursive: true });
		assert.equal((await coordinators.open({ name: "later" }, BACKGROUND_CONTEXT)).id, chosen);
		await until(sessions.sessions, () => row(chosen)?.archivedAt === null);
	});

	it("is archived when its project is archived or deleted while it is being made", async () => {
		for (const name of ["busy", "gone"])
			await projects.create({ name, place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.some((project) => project.name === "gone") === true);
		const archiving = coordinators.open({ name: "busy" }, BACKGROUND_CONTEXT);
		await projects.archive({ name: "busy" }, BACKGROUND_CONTEXT);
		const busy = (await archiving).id;
		await until(sessions.sessions, () => row(busy)?.archivedAt !== null);
		await projects.restore({ name: "busy" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(busy)?.archivedAt === null);

		const removing = coordinators.open({ name: "gone" }, BACKGROUND_CONTEXT);
		await projects.remove({ name: "gone" }, BACKGROUND_CONTEXT);
		const gone = (await removing).id;
		await until(sessions.sessions, () => row(gone)?.archivedAt !== null);
		assert.equal(coordinators.sessions.value?.gone, undefined);
		assert.equal(projects.sessions.value?.[gone], undefined);
	});

	it("gives a former coordinator and a copy of one the default tools back", async () => {
		const tools = async (session: string, restricted: boolean) => {
			const chat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
			await until(chat.view, (view) => view != null && Array.isArray(agentOf(view)?.tools) === restricted);
			chat.release();
		};
		const { id } = await coordinators.open({ name: "busy" }, BACKGROUND_CONTEXT);
		await tools(id, true);
		const copy = await sessions.clone({ id }, BACKGROUND_CONTEXT);
		await tools(copy.id, false);
		await projects.remove({ name: "busy" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, () => row(id)?.archivedAt !== null);
		await sessions.restore({ id }, BACKGROUND_CONTEXT);
		await tools(id, false);
	});

	it("still serves ProjectService 2 to server plugins built before it", async () => {
		const v2 = await bound(fixture.server.host.hold(ProjectServiceV2, {}, BACKGROUND_CONTEXT));
		assert.ok(v2.projects.value.some((project) => project.name === "later"));
		v2.release();
	});
});

const Name = str({ minLength: 1, maxLength: 64 });
const NameOnly = obj({ name: Name });
const Place = obj({ env: union([str({ maxLength: 32 }), nul()]), path: str({ minLength: 1, maxLength: 4096 }) });
const ProjectPlace = obj({ env: union([str(), nul()]), path: str() });

/** `ProjectService` as 29e3fccf7 declared it (comments left out: they are not part of its fingerprint). */
const ProjectServiceV2 = local("p2.project-service", {
	version: 2,
	params: {},
	members: {
		projects: arr(obj({ name: str(), places: arr(ProjectPlace) })),
		archived: arr(obj({ name: str(), places: arr(ProjectPlace), archivedAt: num() })),
		sessions: record(str()),
		assign: method(obj({ session: str({ maxLength: 64 }), project: union([str({ maxLength: 64 }), nul()]) })),
		copy: method(obj({ source: str(), copy: str() })),
		create: method(obj({ name: Name, place: Place })),
		rename: method(obj({ name: Name, to: Name })),
		locate: method(obj({ name: Name, place: Place })),
		move: method(obj({ name: Name, before: union([Name, nul()]) })),
		archive: method(NameOnly),
		restore: method(NameOnly),
		remove: method(NameOnly),
	},
});
