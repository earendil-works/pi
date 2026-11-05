import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Mcp } from "../../plugins/mcp/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { type Child, SubagentControl, Subagents } from "../../plugins/subagents/contract.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, failureOf, holdIn, http, startFixture, until } from "./helpers.ts";

const MCP_FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));

const texts = (view: ConversationView | null | undefined): string[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		),
	);
const result = (view: ConversationView | null | undefined, action: string): ToolResultMessage | undefined =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" &&
				message.toolName === "subagent" &&
				(message.details as { action?: string } | undefined)?.action === action,
		);

describe("subagents (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let chat: RefIn<typeof Chat, "participant">;
	let children: RefIn<typeof Subagents, "reader">;
	let status: RefIn<typeof SessionStatus, "reader">;
	let session: string;
	let child: Child;

	before(async () => {
		fixture = await startFixture({ idleMs: 1500, allowedHosts: ["share.test"] });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		children = await holdIn(owner, Subagents, {}, "reader");
		status = await holdIn(owner, SessionStatus, {}, "reader");
	});
	after(async () => {
		await fixture?.close();
	});

	it("rejects invalid models without creating a child", async () => {
		await chat.send({ text: "subagent-bad", requestId: "bad" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => texts(view).some((text) => text.includes("Unknown model nope/missing")));
		assert.deepEqual((await until(children.children, (value) => value !== undefined))?.[session] ?? [], []);
	});

	it("spawns a configured child and reports its answer once", async () => {
		await chat.send({ text: "subagent", requestId: "spawn" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) =>
			texts(value).some(
				(text) => text.startsWith("[answered, no reply needed]") && text.includes("Echo: hello helper"),
			),
		);
		const spawned = result(view, "spawn");
		assert.equal(spawned?.isError, false);
		assert.deepEqual(
			{ ...(spawned?.details as object), conversationId: undefined },
			{
				action: "spawn",
				name: "helper",
				conversationId: undefined,
				model: "faux/faux-1",
				thinkingLevel: "off",
				tools: ["read"],
			},
		);
		const listed = await until(children.children, (value) => value?.[session]?.length === 1);
		child = listed![session]![0]!;
		assert.equal(child.name, "helper");
		assert.ok(child.conversationId > 1);
		await chat.send({ text: "subagent-answer", requestId: "answer" }, BACKGROUND_CONTEXT);
		const answered = await until(chat.view, (value) => Boolean(result(value, "answer")));
		assert.deepEqual(result(answered, "answer")?.content, [{ type: "text", text: "Echo: hello helper" }]);
		assert.equal(texts(answered).filter((text) => text.startsWith("[answered, no reply needed]")).length, 1);
	});

	it("configures tools and opens a child's independent transcript", async () => {
		await chat.send({ text: "subagent-configure", requestId: "configure" }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => value?.[session]?.[0]?.tools.join() === "bash,artifact");
		const sub = await holdIn(owner, Chat, { session, conversation: child.conversationId }, "participant");
		const view = await until(sub.view, (value) => texts(value).includes("Echo: hello helper"));
		// The sidebar lists the chosen tools; the agent also has `team` (`scope: "subagent"`), offered from the start.
		const agent = view?.docs["pi.agent"] as { tools: string[]; modelTools: { add: string[] } };
		assert.deepEqual(agent.tools, ["bash", "artifact", "team"]);
		assert.deepEqual(agent.modelTools.add, ["team"]);
		await sub.configure({ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => value?.[session]?.[0]?.thinkingLevel === "off");
		await sub.send({ text: "direct child message", requestId: "direct" }, BACKGROUND_CONTEXT);
		await until(sub.view, (value) => texts(value).includes("Echo: direct child message"));
		const root = await until(chat.view, (value) => !(value?.docs["pi.live"] as { run?: unknown })?.run);
		assert.ok(!texts(root).includes("Echo: direct child message"), "direct child prompts do not auto-report");
		sub.release();
		const missing = owner.hold(Chat, { session, conversation: 999 }, BACKGROUND_CONTEXT);
		// A failed open leaves its holders waiting (the conversation may appear): the failure names the cause.
		assert.match((await failureOf(missing)).message, /Unknown conversation/);
		missing.release();
	});

	it("archives through the tool (hidden from status) and restores from the browser", async () => {
		await chat.send({ text: "subagent-archive", requestId: "archive" }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => value?.[session]?.[0]?.archived === true);
		await chat.send({ text: "subagent-status", requestId: "status" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => Boolean(result(value, "status")));
		assert.deepEqual(result(view, "status")?.content, [
			{ type: "text", text: "1 archived (status with a name shows one)." },
		]);
		const control = owner.hold(SubagentControl, { session }, BACKGROUND_CONTEXT);
		await control.archive({ conversation: child.conversationId, archived: false }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => value?.[session]?.[0]?.archived === undefined);
		await assert.rejects(
			control.archive({ conversation: 999, archived: true }, BACKGROUND_CONTEXT),
			/Unknown conversation/,
		);
		// Archiving from the browser stops the child's work first.
		const sub = await holdIn(owner, Chat, { session, conversation: child.conversationId }, "participant");
		await sub.send({ text: "slow archived", requestId: "slow-archived" }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session]?.busy.includes(child.conversationId) === true);
		await control.archive({ conversation: child.conversationId, archived: true }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session]?.busy.includes(child.conversationId) === false);
		await until(children.children, (value) => value?.[session]?.[0]?.archived === true);
		// Sending to it again brings it back.
		await chat.send({ text: "subagent-send", requestId: "send-archived" }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => value?.[session]?.[0]?.archived === undefined);
		await until(sub.view, (value) => texts(value).includes("Echo: hello again"));
		sub.release();
		control.release();
	});

	it("keeps child work alive through main Stop and compatible reload", async () => {
		const sub = await holdIn(owner, Chat, { session, conversation: child.conversationId }, "participant");
		await sub.send({ text: "slow child", requestId: "slow" }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session]?.busy.includes(child.conversationId) === true);
		await chat.stop(BACKGROUND_CONTEXT);
		await fixture.server.reload(["subagents"]);
		await until(sub.view, (value) => texts(value).some((text) => text.startsWith("Echo: slow child")), 30_000);
		sub.release();
	});

	it("retains sidebar children without keeping a worker alive, then reopens Durable history", async () => {
		chat.release();
		// The released Chats linger 30 s on the worker, which keeps it alive (Chord's activity counts lingering objects).
		await until(status.statuses, (value) => value?.[session]?.running === false, 60_000);
		const listed = await until(children.children, (value) => value?.[session]?.[0]?.lastEntryId !== undefined);
		assert.equal(listed?.[session]?.[0]?.name, "helper");
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await until(chat.view, (view) => texts(view).some((text) => text.startsWith("[answered, no reply needed]")));
		await chat.send({ text: "subagent-answer", requestId: "answer-again" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => texts(view).some((text) => text.startsWith("Echo: slow child")));
		await until(status.statuses, (value) => value?.[session]?.tasks === 0);
	});

	it("limits guest sidebar children to their session and disallows reporting", async () => {
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" },
			body: JSON.stringify({ token: links?.[0]?.token, name: "Reader" }),
		});
		assert.equal(joined.status, 200);
		const cookie = String(joined.headers["set-cookie"]).split(";")[0]!;
		const guest = fixture.client({ Host: "share.test", Origin: "https://share.test", Cookie: cookie }).host;
		const list = await holdIn(guest, Subagents, {}, "reader");
		const value = await until(list.children, (value) => Boolean(value?.[session]?.length));
		assert.deepEqual(Object.keys(value!), [session]);
		// @ts-expect-error `report` is a worker's: a reader calling it anyway is refused.
		await expectChord(list.report({ children: [] }, BACKGROUND_CONTEXT), "invalid");
		const sub = await holdIn(guest, Chat, { session, conversation: child.conversationId }, "viewer");
		// Read-only guests cannot archive (read/write guests can, as the owner).
		await expectChord(whenLive(guest.hold(SubagentControl, { session }, BACKGROUND_CONTEXT)), "forbidden");
		await until(sub.view, (view) => texts(view).includes("Echo: hello helper"));
		sub.release();
		list.release();
		await guest.close(BACKGROUND_CONTEXT);
		sharing.release();
	});

	it("loads persisted sidebar children after server restart without starting a worker", async () => {
		await fixture.server.close();
		const restarted = await startServer({
			dataDir: fixture.dataDir,
			port: fixture.server.port,
			fake: true,
			web: false,
		});
		try {
			const client = fixture.browser();
			const list = await holdIn(client, Subagents, {}, "reader");
			const value = await until(list.children, (value) => Boolean(value?.[session]?.length));
			assert.equal(value?.[session]?.[0]?.name, "helper");
			const statuses = await until(
				(await holdIn(client, SessionStatus, {}, "reader")).statuses,
				(value) => value !== undefined,
			);
			assert.equal(statuses?.[session]?.running ?? false, false);
			await client.close(BACKGROUND_CONTEXT);
		} finally {
			await restarted.close();
		}
	});
});

// Pi Mobile 24e3fccdd: spawn takes a cwd (e.g. a git worktree the main agent created first).
describe("a subagent spawned with its own cwd (fake provider)", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
	});
	after(async () => {
		await fixture?.close();
	});

	it("runs its tools there, and its workspace view and uploads follow", async () => {
		const project = await realpath(fixture.workspace);
		await mkdir(join(project, "worktree"));
		await writeFile(join(project, "worktree", "marker.txt"), "inside\n");
		const owner = fixture.browser();
		const session = (await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: project }, BACKGROUND_CONTEXT))
			.id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const children = await holdIn(owner, Subagents, {}, "reader");
		const spawn = (args: object, requestId: string) =>
			chat.send({ text: `subagent ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);

		// A missing directory fails the spawn and creates nothing; only spawn takes a cwd.
		await spawn({ action: "spawn", name: "bad", message: "x", cwd: "missing" }, "missing");
		await until(chat.view, (view) =>
			texts(view).some((text) => text.includes("cwd missing is not an existing directory")),
		);
		await spawn({ action: "spawn", name: "file", message: "x", cwd: "worktree/marker.txt" }, "file");
		await until(chat.view, (view) =>
			texts(view).some((text) => text.includes("cwd worktree/marker.txt is not an existing directory")),
		);
		assert.deepEqual((await until(children.children, (value) => value !== undefined))?.[session] ?? [], []);

		// A relative cwd resolves against the caller's.
		await spawn({ action: "spawn", name: "wt", message: "bash", cwd: "worktree", tools: ["bash"] }, "spawn");
		const view = await until(
			chat.view,
			(value) => texts(value).includes('<sender kind="subagent" name="wt"/>'),
			20_000,
		);
		assert.equal((result(view, "spawn")?.details as { cwd?: string }).cwd, join(project, "worktree"));
		const listed = await until(children.children, (value) => Boolean(value?.[session]?.length));
		const agent = listed?.[session]?.[0];
		assert(agent);
		assert.deepEqual(
			agent.location,
			{ cwd: join(project, "worktree"), env: null },
			"the sidebar listing carries the subagent's own location",
		);
		// Only spawn and configure take a location; configure places it again (here where it is).
		await spawn({ action: "send", name: "wt", message: "x", cwd: "worktree" }, "send-cwd");
		await until(chat.view, (value) => texts(value).includes("Only spawn and configure take a location."));
		await spawn({ action: "configure", name: "wt", tools: ["bash"], cwd: "worktree" }, "configure");
		await until(chat.view, (value) => texts(value).includes("Configured wt."));
		await spawn({ action: "status" }, "status");
		const status = await until(chat.view, (value) => Boolean(result(value, "status")));
		assert.match(
			(result(status, "status")?.content[0] as { text: string }).text,
			new RegExp(`· in ${join(project, "worktree")}$`),
		);

		// Its bash ran in the worktree.
		const sub = await holdIn(owner, Chat, { session, conversation: agent.conversationId }, "participant");
		const child = await until(sub.view, (value) =>
			(value?.entries ?? []).some((entry) => entry.model?.some((message) => message.role === "toolResult")),
		);
		const pwd = (child?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash");
		assert.match(pwd?.content.map((part) => (part.type === "text" ? part.text : "")).join() ?? "", /\/worktree\s*$/);
		sub.release();

		// The workspace panel of each viewed conversation lists its own working directory.
		const list = async (conversation: number) => {
			const workspace = owner.hold(Workspace, { session, conversation }, BACKGROUND_CONTEXT);
			try {
				const listing = await workspace.query({ kind: "list", path: "" }, BACKGROUND_CONTEXT);
				assert(listing.kind === "list");
				return listing.entries.map((entry) => entry.name);
			} finally {
				workspace.release();
			}
		};
		assert.deepEqual(await list(agent.conversationId), ["marker.txt"]);
		assert.deepEqual(await list(1), ["worktree"]);

		// An upload in the subagent's view lands in its directory.
		const upload = await http(
			fixture.server.port,
			`/workspace-upload?${new URLSearchParams({ session, conversation: String(agent.conversationId), path: "", name: "up.txt" })}`,
			{ method: "POST", headers: { Origin: `http://127.0.0.1:${fixture.server.port}` }, body: "uploaded" },
		);
		assert.equal(upload.status, 200, upload.body);
		assert.equal(await readFile(join(project, "worktree", "up.txt"), "utf8"), "uploaded");
		chat.release();
		children.release();
	});
});

describe("subagents with code mode (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let chat: RefIn<typeof Chat, "participant">;
	let children: RefIn<typeof Subagents, "reader">;
	let session: string;
	let sent = 0;
	/** Sends `subagent <args>` and waits for that call's result. */
	const subagent = async (args: object): Promise<ToolResultMessage> => {
		const count = results(chat.view.value).length;
		await chat.send(
			{ text: `subagent ${JSON.stringify(args)}`, requestId: `codemode-${++sent}` },
			BACKGROUND_CONTEXT,
		);
		return results(await until(chat.view, (view) => results(view).length > count)).at(-1)!;
	};
	/** Waits until `name`'s answer was reported and the main agent's turn on it ended, so it cannot race a later send. */
	const reported = (name: string) =>
		until(
			chat.view,
			(view) =>
				texts(view).includes(`<sender kind="subagent" name="${name}"/>`) &&
				!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run,
		);
	const results = (view: ConversationView | null | undefined) =>
		(view?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "subagent",
			);
	const text = (message: ToolResultMessage | undefined) =>
		(message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

	before(async () => {
		fixture = await startFixture();
		await writeFile(join(fixture.workspace, "marker.txt"), "inside\n");
		owner = fixture.browser();
		session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		children = await holdIn(owner, Subagents, {}, "reader");
	});
	after(async () => {
		await fixture?.close();
	});

	it("validates tools against the caller's own, session-level ones excluded", async () => {
		const bad = await subagent({ action: "spawn", name: "bad", message: "x", tools: ["codemode", "bogus"] });
		assert.equal(bad.isError, true);
		assert.match(text(bad), /^Unknown tools: bogus\. Choose from your own tools: .*\bcodemode\b/);
		const main = await subagent({
			action: "spawn",
			name: "bad",
			message: "x",
			tools: ["subagent", "rename_session"],
		});
		assert.match(text(main), /^Unknown tools: subagent, rename_session\. /);
		const chosen = await subagent({ action: "spawn", name: "chosen", message: "x", tools: ["bash", "codemode"] });
		assert.deepEqual((chosen.details as { tools?: string[] }).tools, ["bash", "codemode"]);
		await reported("chosen");
	});

	it("gives all the caller's tools by default; a script calls its tools and the tools behind code mode", async () => {
		// The subagent's script reads with a coding tool, then starts one-shot agents (`agent` is script-only:
		// `callers: ["tools"]`), which may get code mode too, but not the tools that work only in the main conversation.
		const script = [
			'const read = await tools.read({ path: "marker.txt" });',
			'const answer = await tools.agent({ prompt: \'json {"n":1}\', schema: { type: "object" } });',
			'const nested = await tools.agent({ prompt: \'json {"n":2}\', schema: { type: "object" }, tools: ["codemode", "read"] });',
			"let refused;",
			'try { await tools.agent({ prompt: "x", schema: {}, tools: ["subagent"] }); } catch (error) { refused = String(error.message ?? error); }',
			"return { read, answer, nested, refused };",
		].join("\n");
		const spawned = await subagent({ action: "spawn", name: "coder", message: `codemode ${script}` });
		assert.equal(spawned.isError, false, text(spawned));
		const given = (spawned.details as { tools?: string[] }).tools ?? [];
		for (const each of ["read", "bash", "codemode", "history_search", "location_move"])
			assert.ok(given.includes(each), each);
		for (const each of ["subagent", "rename_session", "team", "agent"]) assert.ok(!given.includes(each), each);
		const listed = await until(children.children, (value) =>
			Boolean(value?.[session]?.some((each) => each.name === "coder")),
		);
		const coder = listed![session]!.find((each) => each.name === "coder")!;
		const sub = await holdIn(owner, Chat, { session, conversation: coder.conversationId }, "participant");
		const view = await until(sub.view, (value) =>
			(value?.entries ?? []).some((entry) =>
				entry.model?.some((message) => message.role === "toolResult" && message.toolName === "codemode"),
			),
		);
		const ran = (view?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.find(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
			);
		assert.equal(ran?.isError, false, text(ran));
		const output = text(ran);
		assert.match(output, /^Script completed/);
		const value = JSON.parse(output.slice(output.indexOf("{"))) as {
			read: string;
			answer: unknown;
			nested: unknown;
			refused: string;
		};
		assert.match(value.read, /inside/);
		assert.deepEqual(value.answer, { n: 1 });
		assert.deepEqual(value.nested, { n: 2 });
		assert.match(value.refused, /^Unknown tools: subagent\. Choose from your own tools: /);
		// The script-only tools were enabled by name before the script started; the model is still offered its choice.
		const tools = (sub.view.value?.docs["pi.agent"] as { tools: string[] }).tools;
		assert.ok(tools.includes("agent"), tools.join());
		await reported("coder");
		await until(children.children, (value) =>
			Boolean(value?.[session]?.find((each) => each.name === "coder")?.tools.includes("codemode")),
		);
		sub.release();
	});

	it("reaches MCP tools installed after the spawn", async () => {
		// The server connects after `coder` was spawned: the worker adds its tools to the subagent's tool list.
		await writeFile(
			join(fixture.dataDir, "mcp.json"),
			JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [MCP_FIXTURE] } } }),
		);
		const mcp = await holdIn(owner, Mcp, {}, "owner");
		await until(mcp.instances, (instances) => instances.some((item) => item.status === "connected"));
		const coder = (await until(children.children, (value) => Boolean(value?.[session]?.length)))![session]!.find(
			(each) => each.name === "coder",
		)!;
		const sub = await holdIn(owner, Chat, { session, conversation: coder.conversationId }, "participant");
		const scripts = () =>
			(sub.view.value?.entries ?? [])
				.flatMap((entry) => entry.model ?? [])
				.filter(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolName === "codemode",
				);
		const before = scripts().length;
		const script = 'return await tools.mcp__files__echo({ text: "from coder" });';
		await subagent({ action: "send", name: "coder", message: `codemode ${script}` });
		await until(sub.view, () => scripts().length > before);
		const ran = scripts().at(-1);
		assert.equal(ran?.isError, false, text(ran));
		assert.match(text(ran), /echo: from coder$/);
		await reported("coder");
		sub.release();
		mcp.release();
	});

	it("leaves code mode out while the codemode setting is off, and refuses choosing it", async () => {
		await writeFile(join(fixture.dataDir, "settings.json"), JSON.stringify({ codemode: false }));
		// The worker applies the settings file asynchronously: spawn (a new name each time) until it refuses.
		let refused: ToolResultMessage | undefined;
		for (let attempt = 0; attempt < 20 && !refused?.isError; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
			refused = await subagent({ action: "spawn", name: `off-${attempt}`, message: "x", tools: ["codemode"] });
			if (!refused.isError) await reported(`off-${attempt}`);
		}
		assert.equal(refused?.isError, true);
		assert.match(text(refused), /^Unknown tools: codemode\. Choose from your own tools: /);
		const plain = await subagent({ action: "spawn", name: "plain", message: "x" });
		const given = (plain.details as { tools?: string[] }).tools ?? [];
		assert.ok(given.includes("read") && !given.includes("codemode"), given.join());
	});
});
