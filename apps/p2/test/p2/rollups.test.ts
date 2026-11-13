// Rollups made from code (plugins/rollups): saving runs a script once; its output is checked against the schema, a
// failed run keeps the last good output; `auto` runs again only when a field the script read changed, `manual` only by
// hand; preview saves nothing; the fingerprint covers what a run read; the rollups are the owner's and the Familiar's.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { type RollupDefinition, type RollupEntry, SidebarRollups } from "../../plugins/rollups/contract.ts";
import { fingerprintOf, inputOf, mentionOf, mentionRead, type RollupFacts } from "../../plugins/rollups/runner.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { expectChord, type Fixture, holdIn, settled, startFixture, until } from "./helpers.ts";

/** One group per folder of the sessions it reads (`cwd` only), named by the folder's last segment. */
const BY_FOLDER = `const groups = new Map();
for (const s of sessions) {
	if (!groups.has(s.cwd)) groups.set(s.cwd, []);
	groups.get(s.cwd).push(s.id);
}
return { layout: "groups", groups: [...groups].map(([cwd, members]) => ({ key: cwd, name: cwd.split("/").pop(), members })) };`;

/** Sends `text` in a session's main conversation and waits until its answer is indexed (the fake model echoes). */
async function say(owner: ReturnType<Fixture["browser"]>, session: string, text: string): Promise<void> {
	const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	await chat.send({ text, requestId: `say-${text}` }, BACKGROUND_CONTEXT);
	await until(chat.view, (view) => JSON.stringify(view).includes(`Echo: ${text}`));
	chat.release();
}

describe("rollups made from code", () => {
	let fixture: Fixture;
	let rollups: Awaited<ReturnType<typeof holdIn<typeof SidebarRollups, "owner">>>;
	let sessions: Awaited<ReturnType<typeof holdIn<typeof Sessions, "owner">>>;
	before(async () => {
		fixture = await startFixture();
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		rollups = await holdIn(owner, SidebarRollups, {}, "owner");
		sessions = await holdIn(owner, Sessions, {}, "owner");
	});
	after(async () => {
		await fixture?.close();
	});

	const folder = (name: string) => {
		const path = join(fixture.workspace, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const save = (definition: Partial<RollupDefinition> & Pick<RollupDefinition, "key" | "code">) =>
		rollups.save(
			{ name: definition.key, window: "3d", refresh: { kind: "auto" }, ...definition },
			BACKGROUND_CONTEXT,
		);
	const entryOf = (key: string) => rollups.rollups.value?.find((each) => each.definition.key === key);
	const groupsOf = (entry: RollupEntry | undefined) =>
		entry?.output?.layout === "groups"
			? entry.output.groups.map((group) => [group.name, group.members.length] as const)
			: undefined;

	it("saves a rollup and runs it once, recording what it read", async () => {
		const pi = folder("pi");
		await sessions.create({ cwd: pi, title: "one" }, BACKGROUND_CONTEXT);
		const entry = await save({ key: "folders-by-code", code: BY_FOLDER });
		assert.equal(entry.error, null);
		assert.deepEqual(groupsOf(entry), [["pi", 1]]);
		// `id` and `cwd`: the fields the script read of each session.
		assert.deepEqual(entry.reads.toSorted(), ["sessions.cwd", "sessions.id"]);
		assert.notEqual(entry.checkedAt, null);
	});

	it("runs an automatic rollup again when a field it read changed, and not for others", async () => {
		const web = folder("web");
		const created = await sessions.create({ cwd: web, title: "two" }, BACKGROUND_CONTEXT);
		const after = await until(rollups.rollups, () => groupsOf(entryOf("folders-by-code"))?.length === 2);
		assert.ok(after);
		const checked = entryOf("folders-by-code")?.checkedAt;
		// A rename changes `title`, which the script never read: no run.
		await sessions.rename({ id: created.id, title: "renamed" }, BACKGROUND_CONTEXT);
		await settled(rollups.rollups, 200);
		assert.equal(entryOf("folders-by-code")?.checkedAt, checked);
	});

	it("keeps the last good output when a run fails, and says why", async () => {
		const good = entryOf("folders-by-code");
		const bad = await save({ key: "folders-by-code", code: `return { layout: "groups", groups: [{ key: 1 }] };` });
		assert.match(bad.error ?? "", /does not match its schema/);
		// A replaced script starts over: no output from the previous one.
		assert.equal(bad.output, null);
		assert.ok(good?.output);
		const thrown = await save({ key: "thrower", code: `throw new Error("no luck")` });
		assert.match(thrown.error ?? "", /no luck/);
		// A failed automatic run does not run again while nothing changed (its own write wakes the routine).
		await settled(rollups.rollups, 300);
		assert.equal(entryOf("thrower")?.checkedAt, thrown.checkedAt);
		await save({ key: "thrower", code: `return { layout: "sessions", members: sessions.map((s) => s.id) }` });
		const fixed = await rollups.refresh({ key: "thrower" }, BACKGROUND_CONTEXT);
		assert.equal(fixed.error, null);
		assert.equal(fixed.output?.layout, "sessions");
		await rollups.remove({ key: "folders-by-code" }, BACKGROUND_CONTEXT);
		await rollups.remove({ key: "thrower" }, BACKGROUND_CONTEXT);
	});

	it("does not run an automatic rollup that reads now() again on its own result", async () => {
		const entry = await save({
			key: "clock",
			code: `return { layout: "sessions", members: sessions.filter((s) => now() - s.createdAt < 60000).map((s) => s.id) }`,
		});
		assert.ok(entry.reads.includes("now"));
		await settled(rollups.rollups, 300);
		assert.equal(entryOf("clock")?.checkedAt, entry.checkedAt);
		await rollups.remove({ key: "clock" }, BACKGROUND_CONTEXT);
	});

	it("runs a manual rollup only by hand", async () => {
		const entry = await save({
			key: "count",
			code: `return { layout: "sessions", members: sessions.filter((s) => !s.archivedAt).map((s) => s.id) }`,
			refresh: { kind: "manual" },
		});
		const count = entry.output?.layout === "sessions" ? entry.output.members.length : -1;
		await sessions.create({ cwd: folder("manual"), title: "three" }, BACKGROUND_CONTEXT);
		await settled(rollups.rollups, 200);
		const unchanged = entryOf("count");
		assert.equal(unchanged?.output?.layout === "sessions" && unchanged.output.members.length, count);
		const refreshed = await rollups.refresh({ key: "count" }, BACKGROUND_CONTEXT);
		assert.equal(refreshed.output?.layout === "sessions" && refreshed.output.members.length, count + 1);
		await rollups.remove({ key: "count" }, BACKGROUND_CONTEXT);
	});

	it("previews a script without saving it", async () => {
		const preview = await rollups.preview(
			{ code: `return { layout: "link", members: sessions.slice(0, 1).map((s) => ({ id: s.id, keep: true })) }` },
			BACKGROUND_CONTEXT,
		);
		assert.equal(preview.ok, true);
		assert.equal(preview.ok && preview.output.layout, "link");
		assert.equal(entryOf("preview"), undefined);
		const failed = await rollups.preview({ code: "return 42" }, BACKGROUND_CONTEXT);
		assert.equal(failed.ok, false);
	});

	it("finds the sessions whose messages mention a word with mentions(), and runs again when a new one does", async () => {
		const owner = fixture.browser();
		const talk = async (title: string, text: string) => {
			const { id } = await sessions.create({ cwd: folder("talk"), title }, BACKGROUND_CONTEXT);
			await say(owner, id, text);
			return id;
		};
		const quiet = await talk("Quiet", "nothing to see here");
		const loud = await talk("Loud", "the wombat escaped again");
		const entry = await save({
			key: "wombats",
			code: `const hits = await mentions("wombat");
return { layout: "sessions", members: Object.entries(hits).map(([id, at]) => ({ id, at })) };`,
			window: "1d",
		});
		assert.deepEqual(entry.reads, ['mentions:{"query":"wombat"}']);
		const members = (value: RollupEntry | undefined) =>
			value?.output?.layout === "sessions"
				? value.output.members.map((member) => (typeof member === "string" ? member : member.id))
				: [];
		assert.deepEqual(members(entry), [loud]);
		// A message in another session mentioning it: the index changed what the call answers, so it runs again.
		await say(owner, quiet, "a wombat after all");
		await until(rollups.rollups, () => members(entryOf("wombats")).length === 2);
		// The echoed answer mentions it too and moves that session's time once more.
		await settled(rollups.rollups, 300);
		const checked = entryOf("wombats")?.checkedAt;
		// Activity without the word: the call answers the same, no run.
		await say(owner, loud, "just chatting");
		await settled(rollups.rollups, 300);
		assert.equal(entryOf("wombats")?.checkedAt, checked);
		await rollups.remove({ key: "wombats" }, BACKGROUND_CONTEXT);
	});

	it("is the owner's and the Familiar's: guests and other workers are refused", async () => {
		const guest = fixture
			.as({ kind: "guest", id: "guest", name: "Guest", home: "unknown", sessions: { unknown: "full" }, revision: 1 })
			.hold(SidebarRollups, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(guest), "forbidden");
		guest.release();
		const worker = await holdIn(
			fixture.as({ kind: "worker", session: "not-the-familiar", generation: 1 }),
			SidebarRollups,
			{},
			"familiar",
		);
		await expectChord(worker.list(BACKGROUND_CONTEXT), "forbidden");
	});

	it("is what the Familiar's sidebar_rollups tool saves and lists", async () => {
		const owner = fixture.browser();
		const { id } = await (await holdIn(owner, Familiar, {}, "owner")).open(BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const definition = {
			action: "save",
			key: "working",
			name: "Working",
			window: "none",
			code: `return { layout: "sessions", members: sessions.map((s) => ({ id: s.id, keep: s.state === "working" })) }`,
		};
		await chat.send({ text: `sidebar_rollups ${JSON.stringify(definition)}`, requestId: "save" }, BACKGROUND_CONTEXT);
		await until(rollups.rollups, () => (entryOf("working")?.checkedAt ?? null) !== null);
		assert.equal(entryOf("working")?.definition.window, "none");
		assert.deepEqual(entryOf("working")?.reads.toSorted(), ["sessions.id", "sessions.state"]);
		await until(chat.view, (view) => JSON.stringify(view).includes("Saved."));
		await chat.send({ text: `sidebar_rollups {"action":"list"}`, requestId: "list" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view).includes('working · \\"Working\\" · window none'));
		chat.release();
		await rollups.remove({ key: "working" }, BACKGROUND_CONTEXT);
	});
});

describe("fingerprintOf", () => {
	const session = (id: string, change: Partial<Session> = {}): Session => ({
		id,
		env: null,
		cwd: "/w",
		title: id,
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		pinned: false,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		main: 1,
		branches: [],
		...change,
	});
	const facts = (sessions: Session[]): RollupFacts => ({
		sessions,
		statuses: {},
		answers: {},
		reads: {},
		projects: [],
		memberships: {},
		familiar: null,
	});
	const NONE = new Map<string, unknown>();

	it("covers the sessions' IDs and the fields read, the projects and the time only when read", () => {
		const before = inputOf(facts([session("a"), session("b")]), 1);
		const activity = inputOf(facts([session("a", { updatedAt: 5, title: "new" }), session("b")]), 2);
		const moved = inputOf(facts([session("a", { cwd: "/x" }), session("b")]), 1);
		const added = inputOf(facts([session("a"), session("b"), session("c", { createdAt: 2 })]), 1);
		const reads = ["sessions.cwd"];
		assert.equal(fingerprintOf(before, reads, NONE), fingerprintOf(activity, reads, NONE));
		assert.notEqual(fingerprintOf(before, reads, NONE), fingerprintOf(moved, reads, NONE));
		assert.notEqual(fingerprintOf(before, reads, NONE), fingerprintOf(added, reads, NONE));
		// Every field after `sessions.*`; the time after `now`.
		assert.notEqual(fingerprintOf(before, ["sessions.*"], NONE), fingerprintOf(activity, ["sessions.*"], NONE));
		assert.notEqual(fingerprintOf(before, ["now"], NONE), fingerprintOf(activity, ["now"], NONE));
	});

	it("covers what each mentions call answered, by its read path", () => {
		const input = inputOf(facts([session("a")]), 1);
		const path = mentionRead({ query: "p2" });
		assert.equal(path, 'mentions:{"query":"p2"}');
		assert.deepEqual(mentionOf(mentionRead({ query: "p2", since: 5 })), { query: "p2", since: 5 });
		assert.equal(mentionOf("sessions.cwd"), undefined);
		const once = fingerprintOf(input, [path], new Map([[path, { a: 1 }]]));
		assert.equal(once, fingerprintOf(input, [path], new Map([[path, { a: 1 }]])));
		assert.notEqual(once, fingerprintOf(input, [path], new Map([[path, { a: 2 }]])));
	});

	it("gives the script the sessions oldest first with their state, project and unread answer, but the Familiar", () => {
		const input = inputOf(
			{
				...facts([session("late", { createdAt: 9 }), session("early", { createdAt: 3 }), session("familiar")]),
				familiar: "familiar",
				statuses: { late: { running: true, tasks: 1, busy: [1], work: {} } },
				answers: { early: 4 },
				reads: { early: 2 },
				memberships: { early: "pi" },
			},
			10,
		);
		assert.deepEqual(
			input.sessions.map((each) => [each.id, each.state, each.project, each.unread, each.model]),
			[
				["early", "stopped", "pi", true, "faux/faux-1"],
				["late", "working", null, false, "faux/faux-1"],
			],
		);
	});
});
