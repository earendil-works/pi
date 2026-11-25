// P3 server contracts of p2-tui-port.md (section 10): Chat.compact, abortCompaction, reset, dequeueOwn and the
// guest-safe model metadata; the owner's enabledModels scope; FileIndex (section 8.3). Owner, full guest, view guest.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { rankFiles, withDirectories } from "../../plugins/file-index/rank.ts";
import { Models } from "../../plugins/models/contract.ts";
import { resolveModelScope } from "../../plugins/models/scope.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { Host, VariantOf } from "../../src/runtime/chord.ts";
import { FileIndex } from "../../src/runtime/file-index.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { expectChord, holdIn, http, startFixture, until } from "./helpers.ts";

type Fixture = Awaited<ReturnType<typeof startFixture>>;
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const queued = (view: ConversationView | null | undefined) =>
	(view?.docs["pi.inbox"] as { items?: { id: number }[] } | undefined)?.items ?? [];

/** A guest admitted through a share link of `mode`. */
async function guestOf(fixture: Fixture, owner: Host, session: string, mode: "full" | "view", name: string) {
	const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
	await sharing.link({ mode }, BACKGROUND_CONTEXT);
	const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === mode)));
	const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
	const joined = await http(fixture.server.port, "/join", {
		method: "POST",
		headers,
		body: JSON.stringify({ token: links?.find((link) => link.mode === mode)?.token, name }),
	});
	return fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
}

async function sessionFixture(t: { after(fn: () => unknown): void }) {
	const fixture = await startFixture({ allowedHosts: ["share.test"] });
	t.after(() => fixture.close());
	// Keep almost nothing verbatim, so a short conversation has something to compact.
	writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	const owner = fixture.browser();
	const session = (
		await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
	).id;
	const chat = <V extends VariantOf<typeof Chat>>(host: Host, variant: V) =>
		holdIn(host, Chat, { session, conversation: 1 }, variant);
	return { fixture, owner, session, chat };
}

test("compact, reset and model metadata: owner, full guest and view guest", { timeout: 90_000 }, async (t) => {
	const { fixture, owner, session, chat } = await sessionFixture(t);
	const ownerChat = await chat(owner, "participant");
	t.after(follow(ownerChat.view, () => {}));
	await ownerChat.send({ text: "first", requestId: "a" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => Boolean(view?.entries.some((entry) => entry.kind === "pi.assistant")));
	// Guest-safe model metadata: the conversation's model from the catalog, also for a view-only guest.
	const viewer = await chat(await guestOf(fixture, owner, session, "view", "Viewer"), "viewer");
	assert.equal(viewer.variant, "viewer");
	const meta = await until(viewer.model, (value) => value != null);
	assert.equal(meta?.provider, "faux");
	assert.equal(meta?.modelId, "faux-1");
	assert(typeof meta?.contextWindow === "number" && meta.contextWindow > 0);
	assert(Array.isArray(meta?.thinkingLevels));
	// A reference carries every variant's members; the viewer's binding refuses the participant's (cast: the type has
	// only the viewer's).
	const asParticipant = viewer as unknown as Awaited<ReturnType<typeof chat<"participant">>>;
	await expectChord(asParticipant.compact({}, BACKGROUND_CONTEXT), "invalid");
	await expectChord(asParticipant.reset({}, BACKGROUND_CONTEXT), "invalid");
	await expectChord(asParticipant.dequeueOwn(BACKGROUND_CONTEXT), "invalid");

	// Compaction: a task, then a pi.compaction entry in the view; nothing to abort when idle.
	const { taskId } = await ownerChat.compact({ instructions: "keep it short" }, BACKGROUND_CONTEXT);
	assert(Number.isInteger(taskId));
	await until(ownerChat.view, (view) => Boolean(view?.entries.some((entry) => entry.kind === "pi.compaction")));
	assert.deepEqual(await ownerChat.abortCompaction(BACKGROUND_CONTEXT), { aborted: 0 });

	// A full guest may compact and abort compaction, but not start a new context.
	const guestChat = await chat(await guestOf(fixture, owner, session, "full", "Guest"), "participant");
	assert.equal(guestChat.variant, "participant");
	assert.deepEqual(await guestChat.abortCompaction(BACKGROUND_CONTEXT), { aborted: 0 });
	await expectChord(guestChat.reset({ handoff: "x" }, BACKGROUND_CONTEXT), "forbidden");

	// The owner's reset places a pi.reset entry carrying the handoff.
	await ownerChat.reset({ handoff: "Continue with the tests." }, BACKGROUND_CONTEXT);
	const reset = await until(ownerChat.view, (view) =>
		Boolean(view?.entries.some((entry) => entry.kind === "pi.reset")),
	);
	const marker = reset?.entries.find((entry) => entry.kind === "pi.reset");
	assert.match(JSON.stringify(marker?.model ?? []), /Continue with the tests\./);
	// The handoff belongs to the new-context marker, expandable like a compaction summary, not a user message.
	const items = buildTranscript(wholeView(reset!)).items;
	assert(items.some((item) => item.type === "marker" && item.detail === "Continue with the tests."));
	assert(!items.some((item) => item.type === "user" && item.text === "Continue with the tests."));
});

test("abortCompaction aborts a running compaction", { timeout: 90_000 }, async (t) => {
	const { owner, chat } = await sessionFixture(t);
	const ownerChat = await chat(owner, "participant");
	t.after(follow(ownerChat.view, () => {}));
	await ownerChat.send({ text: "first", requestId: "a" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => Boolean(view?.entries.some((entry) => entry.kind === "pi.assistant")));
	await ownerChat.compact({}, BACKGROUND_CONTEXT);
	// The fake summary streams for a while: the abort marks the task before it places a summary.
	assert.deepEqual(await ownerChat.abortCompaction(BACKGROUND_CONTEXT), { aborted: 1 });
	const after = await until(ownerChat.view, (view) => !live(view)?.compactions?.length);
	assert(!after?.entries.some((entry) => entry.kind === "pi.compaction"), "aborted: no summary");
});

test("dequeueOwn restores only the caller's queued inputs, in order", { timeout: 90_000 }, async (t) => {
	const { fixture, owner, session, chat } = await sessionFixture(t);
	const ownerChat = await chat(owner, "participant");
	const guestChat = await chat(await guestOf(fixture, owner, session, "full", "Guest"), "participant");
	t.after(follow(ownerChat.view, () => {}));
	await ownerChat.send({ text: "slow run", requestId: "run" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => Boolean(live(view)?.run));
	const one = await ownerChat.send({ text: "owner one", requestId: "o1", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
	const theirs = await guestChat.send(
		{ text: "guest one", requestId: "g1", whenBusy: "followUp" },
		BACKGROUND_CONTEXT,
	);
	const two = await ownerChat.send({ text: "owner two", requestId: "o2", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => queued(view).length === 3);
	assert.deepEqual(await ownerChat.dequeueOwn(BACKGROUND_CONTEXT), {
		restored: ["owner one", "owner two"],
		skipped: 0,
	});
	const after = await until(ownerChat.view, (view) => queued(view).length === 1);
	assert.deepEqual(
		queued(after).map((item) => item.id),
		[theirs.submissionId],
	);
	assert(one.submissionId < two.submissionId);
	// The guest's own call returns theirs; nothing of the owner's is left.
	assert.deepEqual(await guestChat.dequeueOwn(BACKGROUND_CONTEXT), { restored: ["guest one"], skipped: 0 });
	assert.deepEqual(await ownerChat.dequeueOwn(BACKGROUND_CONTEXT), { restored: [], skipped: 0 });
	await ownerChat.stop(BACKGROUND_CONTEXT);
});

test("enabledModels: patterns resolve to the scope; the owner saves them to settings.json", async (t) => {
	const models = [
		{ provider: "anthropic", modelId: "claude-sonnet-4-5", name: "S", thinkingLevels: [], contextWindow: 1 },
		{ provider: "anthropic", modelId: "claude-opus-4-5", name: "O", thinkingLevels: [], contextWindow: 1 },
		{ provider: "openrouter", modelId: "qwen:exacto", name: "Q", thinkingLevels: [], contextWindow: 1 },
	];
	assert.deepEqual(resolveModelScope(["*sonnet*:high", "anthropic/claude-opus-4-5", "qwen:exacto", "nope"], models), {
		models: [
			{ provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" },
			{ provider: "anthropic", modelId: "claude-opus-4-5" },
			{ provider: "openrouter", modelId: "qwen:exacto" },
		],
		unmatched: ["nope"],
	});
	assert.deepEqual(resolveModelScope(["claude-*", "anthropic/*"], models).models.length, 2, "no duplicates");

	const fixture = await startFixture();
	t.after(() => fixture.close());
	const ref = fixture.browser().hold(Models, {}, BACKGROUND_CONTEXT);
	await whenLive(ref);
	await ref.setEnabledModels({ patterns: ["faux-*:low", " "] }, BACKGROUND_CONTEXT);
	// The answer follows its state: the page holds the new scope when the call resolves.
	assert.deepEqual(ref.scopedModels.value, [{ provider: "faux", modelId: "faux-1", thinkingLevel: "low" }]);
	assert.deepEqual(ref.enabledModels.value, ["faux-*:low"]);
	assert.deepEqual(JSON.parse(readFileSync(join(fixture.dataDir, "settings.json"), "utf8")).enabledModels, [
		"faux-*:low",
	]);
	await ref.setEnabledModels({ patterns: [] }, BACKGROUND_CONTEXT);
	assert.deepEqual(ref.scopedModels.value, []);
	assert(!("enabledModels" in JSON.parse(readFileSync(join(fixture.dataDir, "settings.json"), "utf8"))));
});

test(
	"FileIndex ranks files and directories in the session directory, follows changes, refuses viewers",
	{
		timeout: 60_000,
	},
	async (t) => {
		// Pure ranking: pi's name scores, directories first on ties, then depth, length and name; fuzzy matches last.
		const items = withDirectories(["src/app.ts", "src/web/app.tsx", "docs/apple.md", "README.md", "src/main.ts"]);
		assert.deepEqual(
			items.filter((item) => item.dir).map((item) => item.path),
			["src", "src/web", "docs"],
		);
		assert.deepEqual(
			rankFiles(items, "app").map((item) => item.path),
			["src/app.ts", "docs/apple.md", "src/web/app.tsx"],
		);
		assert.deepEqual(
			rankFiles(items, "web").map((item) => item.path),
			["src/web", "src/web/app.tsx"],
		);
		assert.deepEqual(
			rankFiles(items, "mn", { kind: "file" }).map((item) => item.path),
			["src/main.ts"],
		);
		assert.deepEqual(rankFiles(items, "", { kind: "dir", limit: 1 }), [{ path: "src", dir: true }]);

		const { fixture, owner, session } = await sessionFixture(t);
		mkdirSync(join(fixture.workspace, "src/web"), { recursive: true });
		writeFileSync(join(fixture.workspace, "src/app.ts"), "");
		writeFileSync(join(fixture.workspace, "src/web/view.tsx"), "");
		writeFileSync(join(fixture.workspace, ".env.example"), "");
		const index = owner.hold(FileIndex, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		await whenLive(index);
		t.after(follow(index.changes, () => {}));
		assert.deepEqual(await index.complete({ query: "view" }, BACKGROUND_CONTEXT), {
			items: [{ path: "src/web/view.tsx", dir: false }],
			truncated: false,
		});
		assert.deepEqual(
			(await index.complete({ query: "", kind: "dir" }, BACKGROUND_CONTEXT)).items.map((item) => item.path),
			["src", "src/web"],
		);
		// Hidden files are included; out-of-scope prefixes complete nothing (cwd-relative only).
		assert.deepEqual(
			(await index.complete({ query: ".env" }, BACKGROUND_CONTEXT)).items.map((item) => item.path),
			[".env.example"],
		);
		for (const query of ["/etc", "~/x", "../x", ".."])
			assert.deepEqual((await index.complete({ query }, BACKGROUND_CONTEXT)).items, []);
		assert.deepEqual(await index.list({ path: "src" }, BACKGROUND_CONTEXT), {
			entries: [
				{ name: "web", dir: true },
				{ name: "app.ts", dir: false },
			],
			truncated: false,
		});
		await assert.rejects(index.list({ path: "../" }, BACKGROUND_CONTEXT), /Invalid path/);
		// A new file advances `changes`; the next query sees it.
		const before = index.changes.value ?? 0;
		writeFileSync(join(fixture.workspace, "src/added.ts"), "");
		await until(index.changes, (value) => (value ?? 0) > before);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.deepEqual(
			(await index.complete({ query: "added" }, BACKGROUND_CONTEXT)).items.map((item) => item.path),
			["src/added.ts"],
		);
		// View-only guests get no file names.
		const viewer = (await guestOf(fixture, owner, session, "view", "Viewer")).hold(
			FileIndex,
			{
				session,
				conversation: 1,
			},
			BACKGROUND_CONTEXT,
		);
		await expectChord(whenLive(viewer), "forbidden");
	},
);

test("ownerName: the owner's next entries carry the configured name; earlier ones keep theirs", async (t) => {
	const { fixture, owner, chat } = await sessionFixture(t);
	const ownerChat = await chat(owner, "participant");
	t.after(follow(ownerChat.view, () => {}));
	const authors = (view: ConversationView | null | undefined) =>
		view
			? buildTranscript(wholeView(view)).items.flatMap((item) => (item.type === "user" ? [item.author?.name] : []))
			: [];
	await ownerChat.send({ text: "before", requestId: "before" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => authors(view).length === 1);
	writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ ownerName: "Mario" }));
	// The worker reads settings.json when it changes; each send reads the name at that moment.
	let sent = 0;
	while (!authors(ownerChat.view.value).includes("Mario")) {
		assert.ok(sent < 50, "the new name reached the worker");
		await ownerChat.send({ text: `after ${sent}`, requestId: `after-${sent++}` }, BACKGROUND_CONTEXT);
		await until(ownerChat.view, (view) => authors(view).length === sent + 1);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(authors(ownerChat.view.value)[0], "Owner");
});
