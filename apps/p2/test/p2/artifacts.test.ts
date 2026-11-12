// Artifacts (plugins/artifacts) with the fake provider: the agent's artifact tools (code mode, namespace `artifact`)
// write, version, edit, read, list, show, open and delete html and md artifacts kept on the server per session; an
// html page's frame is served sandboxed to the session's viewers only; a page holding `ArtifactPage` saves its state,
// reports errors (which ride with the next message, once) and runs the agent's code; a reader looks but changes nothing;
// the session's data export carries the artifacts and its delete removes them.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, Session } from "@p2/app/v1";
import { ArtifactPage, Artifacts } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, http, startFixture, until } from "./helpers.ts";

const PAGE = "<!doctype html><html><head><title>Glyph</title></head><body><p id=p>glyph one</p></body></html>";

/** The script result that follows the newest input saying `said` (the view is a window of the newest entries). */
const scriptAfter = (view: ConversationView | null | undefined, said: string): ToolResultMessage | undefined => {
	const entries = view?.entries ?? [];
	const asked = entries.findLastIndex((entry) => (entry.data as { text?: string } | undefined)?.text === said);
	if (asked < 0) return undefined;
	return entries
		.slice(asked + 1)
		.flatMap((entry) => entry.model ?? [])
		.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		);
};
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
const output = (message: ToolResultMessage | undefined): string =>
	text(message).replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/, "");

describe("artifacts (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let artifacts: RefIn<typeof Artifacts, "editor">;
	let sent = 0;

	/** Has the agent run `code` in code mode; its result. */
	const script = async (code: string): Promise<ToolResultMessage> => {
		// Each message its own text: the same script twice must not find the first one's result.
		const said = `codemode ${code}\n// ${++sent}`;
		await chat.send({ text: said, requestId: `script-${sent}` }, BACKGROUND_CONTEXT);
		let result: ToolResultMessage | undefined;
		await until(chat.view, (value) => {
			result = scriptAfter(value, said);
			return result !== undefined && idle(value);
		});
		return result!;
	};
	/** Runs `code`, which must complete; what it returned, parsed. */
	const run = async (code: string): Promise<unknown> => {
		const result = await script(code);
		assert.equal(result.isError, false, text(result));
		return JSON.parse(output(result));
	};

	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		artifacts = await holdIn(owner, Artifacts, { session }, "editor");
	});
	after(async () => {
		await fixture?.close();
	});

	it("writes, versions, edits, reads and lists artifacts", async () => {
		assert.deepEqual(
			await run(
				`return await tools.artifact_write({ kind: "html", title: "Glyph editor", content: ${JSON.stringify(PAGE)} });`,
			),
			{ id: "glyph-editor", version: 1 },
		);
		// A taken ID made from a title is numbered; giving an ID writes its next version.
		assert.deepEqual(
			await run('return await tools.artifact_write({ kind: "md", title: "Glyph editor", content: "# Notes" });'),
			{ id: "glyph-editor-2", version: 1 },
		);
		assert.deepEqual(
			await run(
				'return await tools.artifact_write({ id: "glyph-editor-2", kind: "md", title: "Notes", content: "# Notes\\n\\nletter a" });',
			),
			{ id: "glyph-editor-2", version: 2 },
		);
		assert.match(
			text(
				await script(
					'await tools.artifact_write({ id: "glyph-editor-2", kind: "html", title: "x", content: "" });',
				),
			),
			/is md, not html/,
		);
		assert.deepEqual(
			await run(
				'return await tools.artifact_edit({ id: "glyph-editor", edits: [{ old: "glyph one", new: "glyph two" }] });',
			),
			{ version: 2 },
		);
		assert.match(
			text(
				await script('await tools.artifact_edit({ id: "glyph-editor", edits: [{ old: "nowhere", new: "x" }] });'),
			),
			/old text not found/,
		);
		const first = (await run('return await tools.artifact_read({ id: "glyph-editor", version: 1 });')) as {
			content: string;
		};
		assert.equal(first.content, PAGE);
		const newest = (await run('return await tools.artifact_read({ id: "glyph-editor" });')) as {
			version: number;
			content: string;
		};
		assert.equal(newest.version, 2);
		assert.match(newest.content, /glyph two/);
		const listed = (await run('return await tools.artifact_list({ kind: "md" });')) as {
			artifacts: { id: string; version: number }[];
		};
		assert.deepEqual(
			listed.artifacts.map((each) => [each.id, each.version]),
			[["glyph-editor-2", 2]],
		);
		const live = await until(artifacts.artifacts, (value) => value?.length === 2);
		assert.deepEqual(
			live?.map((each) => [each.id, each.kind, each.version]),
			[
				["glyph-editor", "html", 2],
				["glyph-editor-2", "md", 2],
			],
		);
	});

	it("shows an artifact in the transcript and opens it as a view", async () => {
		assert.deepEqual(await run('return await tools.artifact_show({ id: "glyph-editor" });'), {
			id: "glyph-editor",
			kind: "html",
		});
		assert.deepEqual(await run('return await tools.artifact_open({ id: "glyph-editor" });'), {
			view: "glyph-editor",
		});
		const views = await holdIn(owner, Views, { session }, "editor");
		const [view] = await until(views.views, (value) => value.length === 1);
		assert.deepEqual([view?.kind, view?.item, view?.title], ["html", "glyph-editor", "Glyph editor"]);
		// Opening it again shows the same view.
		assert.deepEqual(await run('return await tools.artifact_open({ id: "glyph-editor" });'), {
			view: "glyph-editor",
		});
		assert.match(text(await script('await tools.artifact_show({ id: "missing" });')), /No artifact "missing"/);
		views.release();
	});

	it("serves an html version's frame with its bridge, sandboxed, to the session's viewers only", async () => {
		const url = (version: number, id = session, artifact = "glyph-editor") =>
			`/artifact-frame?${new URLSearchParams({ session: id, id: artifact, version: String(version) })}`;
		const page = await fixture.http(url(2));
		assert.equal(page.status, 200);
		assert.match(page.body, /window\.p2view/);
		assert.match(page.body, /glyph two/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /sandbox allow-scripts allow-modals allow-pointer-lock/);
		assert.ok(!csp.includes("allow-same-origin"));
		assert.equal((await fixture.http(url(3))).status, 404);
		assert.equal(
			(await fixture.http(url(1, session, "glyph-editor-2"))).status,
			404,
			"a Markdown artifact is no page",
		);
		assert.equal((await fixture.http(url(1), { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
		const other = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		assert.equal((await fixture.http(url(1, other))).status, 404);
		assert.equal((await http(fixture.server.port, url(1))).status, 403, "no cookie, no page");
	});

	it("keeps a page's state, whole, for the page and the agent", async () => {
		const page = await holdIn(owner, ArtifactPage, { session, id: "glyph-editor" }, "editor");
		assert.equal(await until(page.value, (value) => value !== undefined), null);
		// Larger than any text cut: the agent gets it whole, as an object.
		const points = Array.from({ length: 3000 }, (_, index) => [index, index * 2]);
		await page.setState({ state: { glyph: "a", points } }, BACKGROUND_CONTEXT);
		const read = (await run(
			'const { state } = await tools.artifact_html_state({ id: "glyph-editor" }); return { glyph: state.glyph, points: state.points.length, last: state.points.at(-1) };',
		)) as { glyph: string; points: number; last: number[] };
		assert.deepEqual(read, { glyph: "a", points: 3000, last: [2999, 5998] });
		await run('return await tools.artifact_html_set_state({ id: "glyph-editor", state: { glyph: "b" } });');
		await until(page.value, (value) => JSON.stringify(value) === '{"glyph":"b"}');
		await assert.rejects(page.setState({ state: "x".repeat(300 * 1024) }, BACKGROUND_CONTEXT), /at most/);
		assert.match(
			text(await script('await tools.artifact_html_state({ id: "glyph-editor-2" });')),
			/only html pages have a state/,
		);
		page.release();
	});

	it("runs the agent's code in an open page and sends its new errors with the next message, once", async () => {
		assert.match(
			text(await script('await tools.artifact_html_eval({ id: "glyph-editor", code: "return 1" });')),
			/open/i,
			"no page is open",
		);
		const page = await holdIn(owner, ArtifactPage, { session, id: "glyph-editor" }, "editor");
		const subscription = await page.request.on(({ value }) => {
			void page.answer(
				{ request: value.request, result: { ok: true, value: { ran: value.code } } },
				BACKGROUND_CONTEXT,
			);
		}, BACKGROUND_CONTEXT);
		assert.deepEqual(
			await run('return await tools.artifact_html_eval({ id: "glyph-editor", code: "return document.title" });'),
			{ value: { ran: "return document.title" } },
		);
		await page.report(
			{ errors: ["TypeError: x is undefined"], logs: [{ level: "log", text: "drawn" }] },
			BACKGROUND_CONTEXT,
		);
		// The next message carries the error, once.
		await chat.send({ text: "looks broken", requestId: "errors-1" }, BACKGROUND_CONTEXT);
		const carried = (value: ConversationView | null | undefined, said: string) =>
			(value?.entries ?? []).find(
				(entry) => (entry.data as { text?: string } | undefined)?.text === said && entry.model?.length,
			);
		const view = await until(chat.view, (value) => Boolean(carried(value, "looks broken")) && idle(value));
		const content = (carried(view, "looks broken")?.model?.[0] as UserMessage).content;
		const sentText = Array.isArray(content)
			? content.map((part) => (part.type === "text" ? part.text : "")).join("")
			: content;
		assert.match(sentText, /<artifact-errors>[\s\S]*glyph-editor \(Glyph editor\): TypeError: x is undefined/);
		await chat.send({ text: "and now", requestId: "errors-2" }, BACKGROUND_CONTEXT);
		const next = await until(chat.view, (value) => Boolean(carried(value, "and now")) && idle(value));
		const again = (carried(next, "and now")?.model?.[0] as UserMessage).content;
		assert.doesNotMatch(JSON.stringify(again), /artifact-errors/);
		const errors = (await run('return await tools.artifact_html_errors({ id: "glyph-editor" });')) as {
			errors: { text: string }[];
		};
		assert.deepEqual(
			errors.errors.map((each) => each.text),
			["TypeError: x is undefined"],
		);
		const logs = (await run('return await tools.artifact_html_logs({ id: "glyph-editor" });')) as {
			logs: { level: string; text: string }[];
		};
		assert.ok(logs.logs.some((each) => each.text === "drawn"));
		subscription.stop();
		page.release();
	});

	it("lets a read-only guest look, not change", async () => {
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === "view")));
		const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers,
			body: JSON.stringify({ token: links?.find((link) => link.mode === "view")?.token, name: "Reader" }),
		});
		const cookie = String(joined.headers["set-cookie"]).split(";")[0]!;
		const guest = fixture.client({ ...headers, Cookie: cookie }).host;
		const list = await holdIn(guest, Artifacts, { session }, "reader");
		await until(list.artifacts, (value) => value?.length === 2);
		assert.match((await list.read({ id: "glyph-editor" }, BACKGROUND_CONTEXT)).content, /glyph two/);
		await holdIn(guest, ArtifactPage, { session, id: "glyph-editor" }, "viewer");
		const frame = `/artifact-frame?${new URLSearchParams({ session, id: "glyph-editor", version: "2" })}`;
		assert.equal(
			(await http(fixture.server.port, frame, { headers: { Host: "share.test", Cookie: cookie } })).status,
			200,
		);
		sharing.release();
	});

	it("deletes an artifact with its versions and state", async () => {
		await run(
			`return await tools.artifact_write({ id: "scratch", kind: "html", title: "Scratch", content: "<p>x</p>" });`,
		);
		await run('return await tools.artifact_html_set_state({ id: "scratch", state: { n: 1 } });');
		assert.deepEqual(await run('return await tools.artifact_delete({ id: "scratch" });'), { deleted: "scratch" });
		assert.match(text(await script('await tools.artifact_read({ id: "scratch" });')), /No artifact "scratch"/);
		const frame = `/artifact-frame?${new URLSearchParams({ session, id: "scratch", version: "1" })}`;
		assert.equal((await fixture.http(frame)).status, 404);
	});

	it("goes with the session's data: export carries it, delete removes it", async () => {
		const host = fixture.server.host;
		const parts: unknown[] = [];
		for await (const part of host.exportHostData(Session({ id: session }), BACKGROUND_CONTEXT)) parts.push(part);
		const archive = JSON.stringify(parts);
		assert.match(archive, /glyph two/, "a version's content");
		assert.match(archive, /p2\.artifact-states/, "the pages' states");
		await host.deleteHostData(Session({ id: session }), BACKGROUND_CONTEXT);
		await until(artifacts.artifacts, (value) => value?.length === 0);
	});
});
