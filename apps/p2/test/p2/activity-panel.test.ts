// The docked panel on a wide screen: a turn's steps open beside the chat (not over it), the chat stays usable, and
// the panel and the workspace take each other's place. On a phone, a long turn's timeline opens on its newest steps.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryId, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const rect = (selector: string) =>
	`(e=>e&&(r=>({left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)}))(e.getBoundingClientRect()))(document.querySelector(${JSON.stringify(selector)}))`;

describe("activity panel", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Panel" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send(
			{ text: "codemode await tools.bash({ command: 'echo hi' }); return 1;", requestId: "script" },
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("toolResult"), 30_000);
		chat.release();
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("docks the steps beside the chat on a wide screen, and swaps with the workspace", async () => {
		await browser.metrics(1440, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity]')");
		await browser.click("[data-testid=activity]");
		await browser.wait(
			"document.querySelector('[data-testid=side-dock] [data-testid=activity-sheet] [data-testid=step]')",
		);
		// Beside the chat: the chat ends where the panel begins.
		const main = await browser.evaluate<{ right: number }>(rect("main"));
		const dock = await browser.evaluate<{ left: number; width: number }>(rect("[data-testid=side-dock]"));
		assert.ok(Math.abs(main.right - dock.left) <= 1, `main ends at ${main.right}, the dock starts at ${dock.left}`);
		assert.ok(dock.width >= 400);
		// No backdrop: the chat stays usable.
		assert.equal(await browser.evaluate("document.querySelector('textarea[aria-label=Message]')!==null"), true);
		// The workspace takes the panel's place.
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait("!document.querySelector('[data-testid=side-dock] [data-testid=activity-sheet]')");
		// And the panel the workspace's.
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelector('[data-testid=side-dock] [data-testid=activity-sheet]')");
		await browser.wait("!location.search.includes('workspace') && !document.querySelector('.workspace')");
	});
});

/** One turn of `count` commands, each with its result. */
function longTurn(count: number): ConversationView {
	const conversation = { id: 1 } as ConversationView["conversation"];
	const entries: ConversationView["entries"][number][] = [];
	for (let call = 0; call < count; call++) {
		const id = `call-${call}`;
		const message: AssistantMessage = {
			...fauxAssistantMessage([]),
			content: [{ type: "toolCall", id, name: "bash", arguments: { command: `check ${call}` } }],
			stopReason: "toolUse",
			timestamp: call + 1,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: `ok ${call}` }],
			isError: false,
			timestamp: call + 1,
		};
		entries.push(
			{ id: (call * 2 + 1) as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] },
			{ id: (call * 2 + 2) as EntryId, conversationId: conversation.id, kind: "pi.tool-result", model: [result] },
		);
	}
	return { conversation, entries, docs: {} };
}

it(
	"opens a long turn's timeline at its end, on the newest steps",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("codemode-card.ts");
			await browser.wait("typeof window.showCodemode==='function'");
			await browser.evaluate(`window.showCodemode(${JSON.stringify(longTurn(30))})`);
			await browser.click("[data-testid=activity]");
			await browser.wait("document.querySelectorAll('[data-testid=step]').length===30");
			const page = "document.querySelector('[data-testid=timeline]').closest('[data-drawer-page]')";
			await browser.wait(`${page}.scrollHeight > ${page}.clientHeight * 1.5`);
			assert.ok(
				await browser.evaluate<boolean>(`(p => p.scrollHeight - p.clientHeight - p.scrollTop < 2)(${page})`),
				"the timeline opens scrolled to its end",
			);
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
