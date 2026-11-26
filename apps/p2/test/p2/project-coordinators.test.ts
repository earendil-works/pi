// Project coordinators (plugins/projects): a project's coordinator session, made once on the first open at the project's
// default place and joined to it, restored when archived, owner-only; its worker's tools and prompt section (the
// project's current name), other sessions keep theirs; it follows a rename, stays in its project, is archived and
// restored with it and archived when the project is deleted; the conversations tool starts its sessions in its project
// and lists that project's sessions first.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { ConversationBroker, type Query } from "../../plugins/conversations/contract.ts";
import { ProjectCoordinators, Projects } from "../../plugins/projects/contract.ts";
import { SESSIONS_OWNER, Sessions, type SessionsOwner } from "../../plugins/sessions/contract.ts";
import type { Host, Ref } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, holdWith, startFixture, until } from "./helpers.ts";

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
		assert.deepEqual([row(coordinator)?.cwd, row(coordinator)?.title], [fixture.workspace, "app coordinator"]);
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
});
