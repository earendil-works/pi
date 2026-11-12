// The agent's plugins (docs/agent-plugins.md) with the fake provider: a subagent placed at `local:<data>/plugins`
// writes the skill's example plugin with the ordinary coding tools and applies it with `reload_plugins` (its server
// object is served, its tool is code-mode only, its view kind opens, its web facet is in the page's bundle); an edit
// reloads in place; build errors come back with file and line, refusals with the reason; `pluginFile` resolves in the
// user root, whose skills a local conversation lists; tool selections and guests' turns. Each case has its own server
// and data directory (the plugin root is the data directory's).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { arr, int, obj, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, method, param, remote, serverHost } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { ServerNatives } from "../../src/runtime/server.ts";
import { Browser, browserTests } from "./browser.ts";
import { APP, type Fixture, failureOf, holdIn, http, poll, startFixture, until } from "./helpers.ts";

/** The skill's example plugin. */
const EXAMPLE = join(APP, "plugins/agent-plugins/skills/writing-p2-plugins/example/counter");

/** The example's contract, as a page built with it holds it (the same declaration as `counter/contract.ts`). */
const Counter = remote("counter.board", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: {
		player: {
			state: { count: int(), present: arr(str()) },
			events: { waved: obj({ from: str() }) },
			methods: { add: method(obj({ by: int({ minimum: -100, maximum: 100 }) })), wave: method() },
		},
	},
});

/** A user-root plugin's server object telling what its `pluginFile` resolves to (written below as `notes`). */
const Notes = remote("notes.file", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: { reader: { methods: { read: method(undefined, obj({ path: str(), text: str() })) } } },
});

const NOTES: Record<string, string> = {
	"package.json": '{ "name": "notes", "private": true, "type": "module" }\n',
	"contract.ts": `import { obj, str } from "@earendil-works/pi-schema";
import { method, remote, serverHost } from "@p2/app/v1";
export const Notes = remote("notes.file", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: { reader: { methods: { read: method(undefined, obj({ path: str(), text: str() })) } } },
});
`,
	"server.ts": `import { readFileSync } from "node:fs";
import { pluginFile } from "@earendil-works/chord/plugins";
import { defineFacet } from "@p2/app/v1";
import { Notes } from "./contract.ts";
export default defineFacet((host) => {
	host.serve(Notes, () => ({
		variant: "reader",
		members: { read: async () => ({ path: pluginFile("note.txt"), text: readFileSync(pluginFile("note.txt"), "utf8") }) },
	}));
});
`,
	"worker.ts": `import { pluginFile } from "@earendil-works/chord/plugins";
import { contribute, defineFacet } from "@p2/app/v1";
import { PluginSkills } from "@p2/app/v1/worker";
export default defineFacet((host) => {
	contribute(host, "notes.skills", (self) => self.contribute(PluginSkills, { notes: { dir: pluginFile("skills") } }));
});
`,
	"note.txt": "a note in the user root",
	"skills/taking-notes/SKILL.md": "---\nname: taking-notes\ndescription: Notes sentinel.\n---\nTake notes.\n",
	"skills/clashing/SKILL.md": "---\nname: clashing\ndescription: The plugin's clashing skill.\n---\n",
};

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult"),
	);
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const textOf = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
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

describe("the agent's plugins", () => {
	let fixture: Fixture | undefined;
	let sent = 0;

	afterEach(async () => {
		await fixture?.close();
		fixture = undefined;
	});

	/** A server (with the page's bundle when `web`), its owner and a new session's chat. */
	const start = async (web = false) => {
		fixture = await startFixture({ web, allowedHosts: ["share.test"] });
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		return { fixture, owner, session, chat, root: join(fixture.dataDir, "plugins") };
	};

	/** Has `chat`'s agent call `tool` with `args` (`text`: the whole input); the call's result. */
	const call = async (chat: RefIn<typeof Chat, "participant">, tool: string, args: object | string) => {
		const before = results(chat.view.value).length;
		const text = typeof args === "string" ? `${tool} ${args}` : `${tool} ${JSON.stringify(args)}`;
		await chat.send({ text, requestId: `plugins-${++sent}` }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => results(value).length > before && idle(value), 120_000);
		const message = results(view).at(-1);
		assert.equal(message?.toolName, tool);
		return message!;
	};

	/** Copies the example into the user root and reloads through `chat`'s agent; the reload's text. */
	const applyExample = async (chat: RefIn<typeof Chat, "participant">, root: string) => {
		cpSync(EXAMPLE, join(root, "counter"), { recursive: true });
		return textOf(await call(chat, "reload_plugins", {}));
	};

	it("a subagent at local:<root> writes the example with the coding tools and applies it", async () => {
		const { fixture, owner, session, chat, root } = await start(true);
		// The skill is listed for this conversation (it works on the server's machine), from the plugin's own files.
		await call(chat, "view", { action: "list" });
		assert.match(
			sections(chat.view.value).skills ?? "",
			/<name>writing-p2-plugins<\/name>.*<location>[^<]*plugins\/agent-plugins\/skills\/writing-p2-plugins\/SKILL\.md</,
		);
		assert.equal(sections(chat.view.value)["p2-plugins"], undefined, "no hint on the server's machine");
		const children = await holdIn(owner, Subagents, {}, "reader");
		/** Sends `message` to the subagent and waits for its tool's result and the main agent's turn on its report. */
		let reports = 0;
		const builder = async (message: string) => {
			const action = reports === 0 ? { action: "spawn", env: null, cwd: root } : { action: "send" };
			await call(chat, "subagent", { ...action, name: "builder", message });
			reports++;
			await until(
				chat.view,
				(value) =>
					(value?.entries ?? []).filter((entry) => entry.kind === "p2.agent-message").length === reports &&
					idle(value),
				120_000,
			);
			const listed = await until(children.children, (value) => Boolean(value?.[session]?.length));
			const conversation = listed?.[session]?.find((each) => each.name === "builder")?.conversationId ?? 0;
			const sub = await holdIn(owner, Chat, { session, conversation }, "participant");
			const result = results(await until(sub.view, (value) => results(value).length >= reports)).at(-1);
			sub.release();
			return result;
		};
		const copied = await builder(
			`bash ${JSON.stringify({ command: `cp -r ${JSON.stringify(EXAMPLE)} counter && pwd` })}`,
		);
		assert.equal(copied?.toolName, "bash");
		assert.match(textOf(copied), new RegExp(root.replaceAll("/", "\\/")));
		assert.ok(existsSync(join(root, "counter", "server.ts")), "the subagent's tools act on the server's files");
		const applied = await builder("reload_plugins {}");
		assert.equal(applied?.toolName, "reload_plugins");
		assert.match(textOf(applied), /^counter: applied$/m, textOf(applied));
		// Its server object: the count, who is there, adding, an event.
		const board = await holdIn(owner, Counter, { session }, "player");
		await until(board.present, (value) => value.includes("owner"));
		await board.add({ by: 2 }, BACKGROUND_CONTEXT);
		await until(board.count, (value) => value === 2);
		const waves: string[] = [];
		await board.waved.on(({ value }) => waves.push(value.from), BACKGROUND_CONTEXT);
		await board.wave(BACKGROUND_CONTEXT);
		await poll(() => waves.length === 1, 10_000, "a wave");
		// Its tool is deferred and for code mode only: a script calls it.
		const tools = (chat.view.value?.docs["pi.agent"] as { modelTools?: unknown } | undefined) ?? {};
		assert.doesNotMatch(JSON.stringify(tools), /counter_add/);
		const script = await call(chat, "codemode", "return await tools.counter_add({ by: 3 });");
		assert.match(textOf(script), /The count is/);
		await until(board.count, (value) => value === 5);
		// Its pane: a view of its kind, and its web facet in the page's bundle.
		assert.match(textOf(await call(chat, "view", { action: "open", kind: "counter", title: "Counter" })), /Opened/);
		const views = await holdIn(owner, Views, { session }, "editor");
		await until(views.views, (value) => value.some((view) => view.kind === "counter"));
		const manifest = JSON.parse((await fixture.http("/__p2_web")).body) as { script: string };
		assert.match((await fixture.http(manifest.script)).body, /counter\.web/);
	});

	it("reloads an edited plugin in place: the objects held go on with the new code", async () => {
		const { owner, session, chat, root } = await start();
		assert.match(await applyExample(chat, root), /^counter: applied$/m);
		const board = await holdIn(owner, Counter, { session }, "player");
		await board.add({ by: 1 }, BACKGROUND_CONTEXT);
		await until(board.count, (value) => value === 1);
		const edited = await call(chat, "edit", {
			path: join(root, "counter/server.ts"),
			edits: [{ oldText: "draft.value += by;", newText: "draft.value += by * 10;" }],
		});
		assert.equal(edited.isError, false, textOf(edited));
		assert.match(textOf(await call(chat, "reload_plugins", {})), /^counter: applied$/m);
		await board.add({ by: 1 }, BACKGROUND_CONTEXT);
		await until(board.count, (value) => value === 11);
	});

	it("reports a deleted plugin as removed, named or not, and its objects end", async () => {
		const { fixture, owner, session, chat, root } = await start();
		assert.match(await applyExample(chat, root), /^counter: applied$/m);
		const board = await holdIn(owner, Counter, { session }, "player");
		rmSync(join(root, "counter"), { recursive: true });
		const named = textOf(await call(chat, "reload_plugins", { plugins: ["counter"] }));
		assert.match(named, /^counter: removed$/m, named);
		assert.doesNotMatch(named, /counter: applied/);
		await failureOf(board);
		// Copied and removed again, unnamed: every plugin of the root, and the gone one.
		assert.match(await applyExample(chat, root), /^counter: applied$/m);
		rmSync(join(root, "counter"), { recursive: true });
		const unnamed = textOf(await call(chat, "reload_plugins", {}));
		assert.match(unnamed, /^counter: removed$/m, unnamed);
		assert.doesNotMatch(unnamed, /counter: applied/);
		// Deleted and reloaded in one tick, before the watcher can report it (a phone's file events lag): removed all the
		// same, named or not.
		const natives = await fixture.server.host.root(
			async (ctx) => (await fixture.server.host.registry(ServerNatives, ctx)).value,
			BACKGROUND_CONTEXT,
		);
		assert.ok(natives);
		for (const requested of [["counter"], undefined]) {
			assert.match(await applyExample(chat, root), /^counter: applied$/m);
			rmSync(join(root, "counter"), { recursive: true });
			const result = await natives.plugins.reload(requested);
			assert.deepEqual(
				result.plugins.filter((each) => each.plugin === "counter"),
				[{ plugin: "counter", outcome: "removed" }],
				JSON.stringify(result),
			);
		}
	});

	it("reports build errors with file and line, and refusals with the reason; a failed build applies nothing", async () => {
		const { chat, root } = await start();
		const write = (path: string, content: string) => call(chat, "write", { path: join(root, path), content });
		await write("broken/package.json", '{ "name": "broken", "private": true, "type": "module" }');
		await write(
			"broken/server.ts",
			'import { defineFacet } from "@p2/app/v1";\nexport default defineFacet((host) => {\n\thost.serve(;\n});\n',
		);
		const failed = await call(chat, "reload_plugins", {});
		assert.equal(failed.isError, true);
		assert.match(textOf(failed), /^broken: failed$/m, textOf(failed));
		// Paths are the plugin's (`broken/`), after the failing facet's kind.
		assert.match(textOf(failed), /^ {2}server: server\.ts:3:\d+: /m, textOf(failed));
		// A package outside the API, named with its file and line.
		await write("broken/server.ts", 'import { readFileSync } from "fs-extra";\nexport default readFileSync;\n');
		assert.match(textOf(await call(chat, "reload_plugins", {})), /server\.ts:1:\d+: .*fs-extra/);
		// A built-in's name, and an unknown plugin, are refused with the reason.
		await write("chat/package.json", '{ "name": "chat", "private": true, "type": "module" }');
		const refused = textOf(await call(chat, "reload_plugins", {}));
		assert.match(refused, /^chat: refused$/m, refused);
		assert.match(
			textOf(await call(chat, "reload_plugins", { plugins: ["nowhere"] })),
			/^nowhere: refused\n {2}No such plugin/m,
		);
	});

	it("resolves pluginFile in the user root, and lists its skills after the project's", async () => {
		const { owner, chat, root, fixture } = await start();
		for (const [path, content] of Object.entries(NOTES)) {
			mkdirSync(join(root, "notes", path, ".."), { recursive: true });
			writeFileSync(join(root, "notes", path), content);
		}
		// The project's skill of the same name wins over the plugin's.
		mkdirSync(join(fixture.workspace, ".pi/skills/clashing"), { recursive: true });
		writeFileSync(
			join(fixture.workspace, ".pi/skills/clashing/SKILL.md"),
			"---\nname: clashing\ndescription: The project's clashing skill.\n---\n",
		);
		assert.match(textOf(await call(chat, "reload_plugins", {})), /^notes: applied$/m);
		const notes = await holdIn(owner, Notes, {}, "reader");
		assert.deepEqual(await notes.read(BACKGROUND_CONTEXT), {
			path: join(root, "notes", "note.txt"),
			text: "a note in the user root",
		});
		// The next turn's prompt lists the plugin's skill, from its files in the user root.
		await call(chat, "view", { action: "list" });
		const skills = sections(chat.view.value).skills ?? "";
		assert.ok(skills.includes(`<location>${join(root, "notes/skills/taking-notes/SKILL.md")}</location>`), skills);
		assert.match(skills, /The project&apos;s clashing skill/);
		assert.doesNotMatch(skills, /The plugin&apos;s clashing skill/);
	});

	it("is governed by tool selections: an agent given other tools cannot reload", async () => {
		const { owner, session, chat } = await start();
		const spawn = async (args: object) => (await call(chat, "subagent", args)).details as { tools?: string[] };
		assert.ok((await spawn({ action: "spawn", name: "full", message: "hi" })).tools?.includes("reload_plugins"));
		// Its report starts a turn of the main agent; the next send waits for it (the fake answers the last input only).
		await until(
			chat.view,
			(value) => value?.entries.some((entry) => entry.kind === "p2.agent-message") === true && idle(value),
		);
		const lean = await spawn({ action: "spawn", name: "lean", message: "reload_plugins {}", tools: ["read"] });
		assert.deepEqual(lean.tools, ["read"]);
		const children = await holdIn(owner, Subagents, {}, "reader");
		const listed = await until(children.children, (value) =>
			Boolean(value?.[session]?.some((each) => each.name === "lean")),
		);
		const conversation = listed?.[session]?.find((each) => each.name === "lean")?.conversationId ?? 0;
		const sub = await holdIn(owner, Chat, { session, conversation }, "participant");
		const view = await until(sub.view, (value) =>
			results(value).some((message) => message.toolName === "reload_plugins"),
		);
		const refused = results(view).find((message) => message.toolName === "reload_plugins");
		assert.equal(refused?.isError, true);
		assert.doesNotMatch(textOf(refused), /applied|No plugin changed/);
	});

	it("serves a guest's turn the tools that were owner-only (no per-turn authority)", async () => {
		const { fixture, owner, session } = await start();
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers,
			body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
		});
		const guest: Host = fixture.client({
			...headers,
			Cookie: String(joined.headers["set-cookie"]).split(";")[0]!,
		}).host;
		const guestChat = await holdIn(guest, Chat, { session, conversation: 1 }, "participant");
		const reloaded = await call(guestChat, "reload_plugins", {});
		assert.equal(reloaded.isError, false, textOf(reloaded));
		const library = await call(guestChat, "view", { action: "saved" });
		assert.equal(library.isError, false, textOf(library));
		assert.match(textOf(library), /No saved views/);
		guestChat.release();
		sharing.release();
		await guest.close(BACKGROUND_CONTEXT);
	});

	it(
		"shows the plugin's pane in the page: unknown before the reload, the plugin's after",
		{ skip: !browserTests },
		async () => {
			const { fixture, session, chat, root } = await start(true);
			assert.match(
				textOf(await call(chat, "view", { action: "open", kind: "counter", title: "Counter" })),
				/Opened/,
			);
			const browser = await Browser.start();
			try {
				await browser.metrics(1400, 860);
				await browser.signIn(fixture.owner);
				await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
				await browser.wait(
					`document.querySelector('.kind-counter .empty-note')?.textContent.includes('Unknown view kind')`,
				);
				assert.match(await applyExample(chat, root), /^counter: applied$/m);
				// The open page moves onto the new bundle by itself and shows the plugin's pane.
				await browser.wait(`document.querySelector('.kind-counter .counter-count')?.textContent === '0'`);
				await browser.click(".kind-counter button");
				await browser.wait(`document.querySelector('.kind-counter .counter-count')?.textContent === '1'`);
				await browser.wait(`document.querySelector('.kind-counter')?.textContent.includes('Here: owner')`);
			} finally {
				await browser.close();
			}
		},
	);
});
