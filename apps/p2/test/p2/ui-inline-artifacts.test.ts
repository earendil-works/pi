// Inline artifacts (`artifact_show`, called from a code-mode script) in Chromium: the artifact's pane renders in place
// (right after its script's wheel, before the answer), Markdown as in Markdown views, an html page in its sandboxed
// frame fitted to the content height it reports (capped at 70vh), for the owner and for a guest alike; a deleted
// artifact says so. Fake provider (`codemode <script>`), disposable sessions.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

type Shown = { id: string; title: string; kind: "html" | "md"; content: string };

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;
const card = (id: string) => `document.querySelector('.artifact-inline[data-artifact="${id}"]')`;
const frame = (id: string) => `${card(id)}?.querySelector('iframe')`;

describe("inline artifacts in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: RefIn<typeof Sessions, "owner">;

	/** A new session whose agent writes and shows each of `shown`, a script each, and then runs `then` if given. */
	const publish = async (title: string, shown: Shown[], then?: string): Promise<string> => {
		const id = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		const scripts = [
			...shown.map(
				(each) =>
					`await tools.artifact_write(${JSON.stringify(each)});\nawait tools.artifact_show({ id: ${JSON.stringify(each.id)} });`,
			),
			...(then ? [then] : []),
		];
		for (const [index, code] of scripts.entries()) {
			await chat.send({ text: `codemode ${code}`, requestId: `script-${index}` }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => {
				const done = (view?.entries ?? []).flatMap((entry) =>
					(entry.model ?? []).filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolName === "codemode" && !message.isError,
					),
				);
				return done.length === index + 1 && !(view?.docs["pi.live"] as { run?: unknown })?.run;
			});
		}
		chat.release();
		return id;
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("renders inline Markdown as Markdown views do, in place, without a tap", async () => {
		const id = await publish("Inline Markdown", [
			{ id: "notes", title: "Notes", kind: "md", content: "# Inline heading\n\nSome **bold** text" },
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${card("notes")}?.querySelector('.elanor-markdown strong')?.textContent==='bold'`);
		assert.match(await browser.evaluate<string>(`${card("notes")}.textContent`), /Inline heading/);
		// Where it was shown: right after its script's wheel, before the answer.
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('[data-row]')].map((row)=>row.querySelector('[data-testid=activity]')?'activity':row.querySelector('.artifact-inline')?'inline':row.textContent.includes('Echo:')?'answer':'').filter(Boolean)`,
			),
			["activity", "inline", "activity", "answer"],
		);
	});

	it("runs an html page in its sandboxed frame, fitted to its content and capped at 70vh", async () => {
		const id = await publish("Inline HTML", [
			{
				id: "page",
				title: "Page",
				kind: "html",
				content:
					"<!doctype html><html><head><title>Page</title></head><body style='margin:0'><div style='height:240px;background:#09c'>HTML inline</div></body></html>",
			},
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${frame("page")}?.getBoundingClientRect().height===240`);
		assert.equal(
			await browser.evaluate<string>(`${frame("page")}.getAttribute('sandbox')`),
			"allow-scripts allow-modals allow-pointer-lock",
		);
		assert.equal(
			await browser.evaluate<string>(`${frame("page")}.getAttribute('src')`),
			`/artifact-frame?session=${id}&id=page&version=1`,
		);
		// An opaque origin: the page cannot reach into the frame.
		assert.equal(await browser.evaluate<boolean>(`${frame("page")}.contentDocument===null`), true);
		// Taller content stops at 70vh.
		const tall = await publish("Inline tall HTML", [
			{
				id: "tall",
				title: "Tall",
				kind: "html",
				content: "<!doctype html><html><body style='margin:0'><div style='height:3000px'>tall</div></body></html>",
			},
		]);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${tall}`);
		await browser.wait(`Math.abs(${frame("tall")}?.getBoundingClientRect().height-${Math.round(844 * 0.7)})<=1`);
	});

	it("says when the artifact was deleted", async () => {
		const id = await publish(
			"Inline gone",
			[{ id: "gone", title: "Gone", kind: "md", content: "# Gone" }],
			'await tools.artifact_delete({ id: "gone" });',
		);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${card("gone")}?.textContent.includes('No artifact "gone" (it was deleted)')`);
	});

	it("renders inline html and Markdown for a read-only guest too, without a tap", async () => {
		const id = await publish("Inline for guests", [
			{ id: "notes", title: "Notes", kind: "md", content: "Some **bold** text" },
			{
				id: "page",
				title: "Page",
				kind: "html",
				content:
					"<!doctype html><html><head><title>Page</title></head><body style='margin:0'><div style='height:240px;background:#09c'>HTML inline</div></body></html>",
			},
		]);
		const sharing = fixture.browser().hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 1);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 900);
			// A fresh profile on loopback gets the join form and joins as a guest (loopback-join.test.ts).
			await guest.open(`http://127.0.0.1:${fixture.server.port}${new URL(links![0]!.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await guest.evaluate(setInput("#name", "Reader"));
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			// The page reports its content height: its scripts ran in the frame, so it rendered.
			await guest.evaluate(`${card("page")}?.scrollIntoView({ block: "center" })`);
			await guest.wait(`${frame("page")}?.getBoundingClientRect().height===240`);
			await guest.wait(`${card("notes")}?.querySelector('.elanor-markdown strong')?.textContent==='bold'`);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
