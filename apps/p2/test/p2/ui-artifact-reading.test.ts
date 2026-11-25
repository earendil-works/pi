// A Markdown artifact open beside the transcript keeps the reader's place when the agent writes a new version: the
// heading at the top of the pane stays there, also when the new version inserts text above it, and the pane never
// blanks or jumps to the top (it did: each version showed a spinner, then the document from its start). Fake provider
// (`codemode <script>`), a disposable session.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat, type ChatParticipant } from "../../plugins/chat/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

/** A long document: `sections` sections of a few paragraphs each, `before` paragraphs ahead of the first. */
const doc = (version: number, before: number) =>
	[
		`# Core model (version ${version})`,
		...Array.from({ length: before }, (_, index) => `An inserted paragraph ${index + 1} of version ${version}.`),
		...Array.from({ length: 30 }, (_, section) =>
			[
				`## Section ${section + 1}`,
				...Array.from(
					{ length: 2 },
					(_, paragraph) =>
						`Paragraph ${paragraph + 1} of section ${section + 1}: ${"words to read ".repeat(8).trim()}.`,
				),
			].join("\n\n"),
		),
	].join("\n\n");

const PANE = `document.querySelector('[data-view-pane="core"] .artifact-md')`;
/** Any heading (Elanor's Markdown starts its levels lower than the source's). */
const HEADINGS = "'h1,h2,h3,h4,h5,h6'";
/** The heading of section `n` and its top relative to the pane's. */
const headingTop = (n: number) =>
	`(() => { const pane = ${PANE}; const h = [...pane.querySelectorAll(${HEADINGS})].find((e) => e.textContent === 'Section ${n}'); return h.getBoundingClientRect().top - pane.getBoundingClientRect().top; })()`;

describe("a Markdown artifact beside the transcript", { skip: !browserTests, timeout: 120_000 }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let session: string;
	let chat: ChatParticipant;
	let calls = 0;

	/** Runs `code` in code mode as the agent, and waits for its turn to end. */
	const script = async (code: string) => {
		calls++;
		await chat.send({ text: `codemode ${code}`, requestId: `script-${calls}` }, BACKGROUND_CONTEXT);
		const results = await until(
			chat.view,
			(value) => {
				const done = (value?.entries ?? []).flatMap((entry) =>
					(entry.model ?? []).filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolName === "codemode",
					),
				);
				return done.length === calls && !(value?.docs["pi.live"] as { run?: unknown })?.run;
			},
			60_000,
		);
		const result = (results?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.at(-1);
		assert.equal(result?.isError, false, JSON.stringify(result?.content));
	};
	const write = (version: number, before: number) =>
		script(
			`await tools.artifact_write({ id: "core-model", kind: "md", title: "Core model", content: ${JSON.stringify(doc(version, before))} });`,
		);

	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		const sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		session = (await sessions.create({ cwd: fixture.workspace, title: "Reading" }, BACKGROUND_CONTEXT)).id;
		chat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
		await write(1, 0);
		await script(`await tools.view_open({ kind: "md", item: "core-model", title: "Core model", id: "core" });`);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("keeps the heading the reader had at the top across new versions", async () => {
		await browser.metrics(1400, 860);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`${PANE}?.querySelector(${HEADINGS})?.textContent === 'Core model (version 1)'`);
		// The reader scrolls to the middle: section 20's heading a little below the pane's top.
		await browser.evaluate(`(() => { const pane = ${PANE}; pane.scrollTop += ${headingTop(20)} - 40; })()`);
		await browser.wait(`Math.abs(${headingTop(20)} - 40) < 1`);
		// Watch for the pane blanking or jumping while the versions arrive.
		await browser.evaluate(
			`(() => { const pane = ${PANE}; window.paneJumps = 0; pane.addEventListener('scroll', () => { if (pane.scrollTop < 100) window.paneJumps++; }); })()`,
		);
		// A new version with paragraphs inserted above what the reader sees.
		await write(2, 5);
		await browser.wait(`${PANE}?.querySelector(${HEADINGS})?.textContent === 'Core model (version 2)'`);
		assert.ok(Math.abs((await browser.evaluate<number>(headingTop(20))) - 40) < 2);
		// And one that changes nothing above it.
		await write(3, 5);
		await browser.wait(`${PANE}?.querySelector(${HEADINGS})?.textContent === 'Core model (version 3)'`);
		assert.ok(Math.abs((await browser.evaluate<number>(headingTop(20))) - 40) < 2);
		assert.equal(await browser.evaluate<number>("window.paneJumps"), 0);
	});
});
