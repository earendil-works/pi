import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame } from "../../plugins/terminals/protocol.ts";
import { Browser, browserTests } from "./browser.ts";
import { APP, holdIn, startFixture } from "./helpers.ts";

let unavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	unavailable = String(error);
}

// Touch on the terminal (Terminal.tsx). Headless Chromium has no long-press gesture: CDP touches never select a word,
// open Chrome's Copy/Paste menus or show selection handles (a held touch ends as a tap). These tests check what the
// native gestures depend on: where the textarea is during a long press, that no touch event is cancelled, the paste
// and copy events, and that a selection survives output. The native menus themselves need a phone.

/** A page with a touch screen showing a new terminal; its socket is wrapped so tests see sent bytes and inject output. */
async function withTerminal(run: (page: Browser, origin: string) => Promise<void>): Promise<void> {
	const shell = process.env.SHELL;
	process.env.SHELL = "/bin/sh";
	const fixture = await startFixture({ web: true });
	let browser: Browser | undefined;
	try {
		const owner = fixture.browser();
		const id = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const origin = `http://127.0.0.1:${fixture.server.port}`;
		browser = await Browser.start();
		const page = browser;
		await page.metrics(390, 844);
		await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
		await page.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `
			window.terminalBytes=[];
			window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){
				const socket=Reflect.construct(Target,args);
				if(String(args[0]).includes('/terminal')){
					window.terminalSocket=socket;
					const send=socket.send.bind(socket);
					socket.send=data=>{if(typeof data==='string')send(data);else window.terminalBytes.push([...new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength)]);};
				}
				return socket;
			}});`,
		});
		await page.open(`${origin}/s/${id}`);
		await page.wait("document.querySelector('button[aria-label=Terminal]')");
		await page.evaluate("document.querySelector('button[aria-label=Terminal]').click()");
		await page.wait(
			"document.querySelector('.terminal-row')?.textContent.includes('$') || document.querySelector('.terminal-row')?.textContent.includes('#')",
		);
		await run(page, origin);
	} finally {
		await browser?.close();
		const host = await connectTerminalHost(fixture.dataDir, APP);
		host.resume();
		host.write(encodeFrame({ type: "shutdown" }));
		await new Promise((resolve) => host.once("close", resolve));
		await fixture.close();
		if (shell === undefined) delete process.env.SHELL;
		else process.env.SHELL = shell;
	}
}

/** Output from the program, straight into the page's terminal (the shell does not see it). */
function output(page: Browser, text: string): Promise<unknown> {
	return page.evaluate(
		`window.terminalSocket.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode(${JSON.stringify(text)}).buffer}))`,
	);
}

test(
	"touch terminal: a long press on a blank spot is a native paste target; clipboard key, denial, scrolling",
	{ timeout: 60000, skip: !browserTests ? "no Chromium" : unavailable },
	() =>
		withTerminal(async (page, origin) => {
			await page.wait("document.querySelector('button[aria-label=\"Paste into terminal\"]')");
			// A blank cell: the prompt is on the first row.
			let point = await page.evaluate<{ x: number; y: number }>(
				`(()=>{const r=document.querySelector('.terminal-content').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(70,r.height/2)}})()`,
			);
			const touch = (type: string, x = point.x, y = point.y) =>
				page.call("Input.dispatchTouchEvent", {
					type,
					touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
				});
			await touch("touchStart");
			await delay(700);
			const native = await page.evaluate<{
				underFinger: boolean;
				focused: boolean;
				width: number;
				height: number;
				pointer: string;
				selection: string;
				background: string;
				contextAllowed: boolean;
			}>(
				`(()=>{const e=document.querySelector('.terminal-input'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
		const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});
		return {underFinger:document.elementFromPoint(${point.x},${point.y})===e,focused:document.activeElement===e,width:r.width,height:r.height,pointer:s.pointerEvents,selection:s.userSelect,background:s.backgroundColor,contextAllowed:e.dispatchEvent(event)}})()`,
			);
			assert(native.underFinger && native.focused, JSON.stringify(native));
			assert(native.width >= 40 && native.height >= 40);
			assert.equal(native.pointer, "auto");
			assert.equal(native.selection, "text");
			assert.equal(native.background, "rgba(0, 0, 0, 0)");
			assert(native.contextAllowed);
			await touch("touchEnd");
			await page.evaluate(
				`(()=>{const data=new DataTransfer();data.setData('text/plain','plain\\nlines');document.querySelector('.terminal-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`,
			);
			assert.equal(
				await page.evaluate<string>("new TextDecoder().decode(new Uint8Array(window.terminalBytes.at(-1)))"),
				"plain\rlines",
			);
			// Mode 2004 is terminal output, so both UI entry points must use Ghostty's existing encoder.
			await page.evaluate(
				`window.terminalSocket.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode('\\x1b[?2004h').buffer}))`,
			);
			await delay(100);
			const pasted = "first\nsecond\u001bthird";
			await page.evaluate(
				`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pasted)});document.querySelector('.terminal-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`,
			);
			assert.equal(
				await page.evaluate<string>("new TextDecoder().decode(new Uint8Array(window.terminalBytes.at(-1)))"),
				"\x1b[200~first\nsecond third\x1b[201~",
			);
			await page.call("Browser.grantPermissions", {
				origin,
				permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
			});
			await page.evaluate("navigator.clipboard.writeText('toolbar\\npaste')");
			const pastePoint = await page.evaluate<{ x: number; y: number }>(
				`(()=>{const r=document.querySelector('button[aria-label="Paste into terminal"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
			);
			const tapPaste = async () => {
				await page.call("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ ...pastePoint, id: 1 }],
				});
				await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			};
			await tapPaste();
			await page.wait("window.terminalBytes.length === 3");
			assert.equal(
				await page.evaluate<string>("new TextDecoder().decode(new Uint8Array(window.terminalBytes.at(-1)))"),
				"\x1b[200~toolbar\npaste\x1b[201~",
			);
			await page.call("Browser.setPermission", {
				origin,
				permission: { name: "clipboard-read" },
				setting: "denied",
			});
			await tapPaste();
			await page.wait("document.querySelector('.terminal output')?.textContent.includes('Long-press')");
			assert.equal(await page.evaluate<number>("window.terminalBytes.length"), 3, "denial sends nothing");
			// A swipe cancels the editing target and still moves through the terminal's scrollback.
			const lines = Array.from({ length: 80 }, (_, index) => `copy-line-${index}\r\n`).join("");
			await page.evaluate(
				`window.terminalSocket.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode(${JSON.stringify(lines)}).buffer}))`,
			);
			await page.wait("document.querySelector('.terminal-content').textContent.includes('copy-line-79')");
			const beforeScroll = await page.evaluate<string>("document.querySelector('.terminal-row').textContent");
			// Clipboard denial adds a notice above the screen; use its current layout and a real multi-frame swipe.
			point = await page.evaluate<{ x: number; y: number }>(
				`(()=>{const r=document.querySelector('.terminal-content').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(70,r.height/2)}})()`,
			);
			await touch("touchStart");
			for (let step = 1; step <= 3; step++) {
				await touch("touchMove", point.x, point.y + step * 20);
				await delay(30);
			}
			await delay(120); // Lift after stopping, without a fling that redraws the selection below.
			await touch("touchEnd");
			await page.wait(`document.querySelector('.terminal-row').textContent !== ${JSON.stringify(beforeScroll)}`);
			assert.equal(
				await page.evaluate<boolean>("document.querySelector('.terminal-input').hasAttribute('data-native-menu')"),
				false,
			);
			await page.evaluate(
				`(()=>{document.querySelector('.terminal-input').blur();const range=document.createRange();range.selectNodeContents([...document.querySelectorAll('.terminal-row')].find(row=>row.textContent.trim()));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`,
			);
			const selection = await page.evaluate<string>("getSelection().getRangeAt(0).toString()");
			assert(selection.trim());
			assert.equal(await page.evaluate<boolean>("getSelection().isCollapsed"), false);
			await page.evaluate(
				`window.terminalSocket.dispatchEvent(new MessageEvent('message',{data:new TextEncoder().encode('\\x1b[?1000h').buffer}))`,
			);
			await delay(100);
			assert.equal(
				await page.evaluate<boolean>(
					`document.querySelector('.terminal-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
				),
				true,
				"Copy menu remains available even when the program tracks the mouse",
			);
			await touch("touchStart");
			await delay(400);
			assert.equal(await page.evaluate<string>("getSelection().getRangeAt(0).toString()"), selection);
			assert.equal(
				await page.evaluate<boolean>("document.querySelector('.terminal-input').hasAttribute('data-native-menu')"),
				false,
			);
			await touch("touchEnd");
		}),
);

test(
	"touch terminal: a long press on output stays native, the selection survives output, Copy joins wrapped rows",
	{ timeout: 60000, skip: !browserTests ? "no Chromium" : unavailable },
	() =>
		withTerminal(async (page) => {
			// Every touch event and contextmenu after the page's own listeners ran: none may be cancelled.
			await page.evaluate(
				`window.cancelled=[];for(const type of ['touchstart','touchmove','touchend','pointerdown','pointerup','contextmenu'])window.addEventListener(type,event=>{if(event.defaultPrevented)window.cancelled.push(type)});`,
			);
			// A program that tracks the mouse: a tap clicks in it, so a long press that ended as a tap would send bytes.
			await output(page, "\x1b[?1000h\r\nselect-me please\r\n");
			await page.wait(
				"[...document.querySelectorAll('.terminal-row')].some(row=>row.textContent.includes('select-me'))",
			);
			const word = `(()=>{const row=[...document.querySelectorAll('.terminal-row')].find(row=>row.textContent.includes('select-me'));
				const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.data.includes('select-me'));
				const range=document.createRange();const start=node.data.indexOf('select-me');range.setStart(node,start);range.setEnd(node,start+9);return range;})()`;
			const point = await page.evaluate<{ x: number; y: number }>(
				`(()=>{const r=${word}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
			);
			const sent = await page.evaluate<number>("window.terminalBytes.length");
			await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
			await delay(700);
			const held = await page.evaluate<{ native: boolean; hit: string; focused: boolean }>(
				`(()=>{const e=document.querySelector('.terminal-input');return {native:e.hasAttribute('data-native-menu'),hit:document.elementFromPoint(${point.x},${point.y}).closest('.terminal-row')?'row':document.elementFromPoint(${point.x},${point.y}).className,focused:document.activeElement===e}})()`,
			);
			// Chrome selects the word under the finger, not in a textarea moved there, and the keyboard stays down.
			assert.deepEqual(held, { native: false, hit: "row", focused: false });
			// What Chrome's long press does next, which CDP cannot: select the word and send a touch contextmenu.
			await page.evaluate(
				`(()=>{const selection=getSelection();selection.removeAllRanges();selection.addRange(${word});})()`,
			);
			assert.equal(
				await page.evaluate<boolean>(
					"document.querySelector('.terminal-row').dispatchEvent(new PointerEvent('contextmenu',{pointerType:'touch',bubbles:true,cancelable:true}))",
				),
				true,
			);
			await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await delay(200);
			assert.equal(await page.evaluate<number>("window.terminalBytes.length"), sent, "a long press is no tap");
			assert.deepEqual(await page.evaluate<string[]>("window.cancelled"), []);
			// A touch contextmenu is never the program's right button, even with nothing selected; a mouse's is.
			await page.evaluate("getSelection().removeAllRanges()");
			assert.equal(
				await page.evaluate<boolean>(
					"document.querySelector('.terminal-row').dispatchEvent(new PointerEvent('contextmenu',{pointerType:'touch',bubbles:true,cancelable:true}))",
				),
				true,
			);
			assert.equal(
				await page.evaluate<boolean>(
					"document.querySelector('.terminal-row').dispatchEvent(new PointerEvent('contextmenu',{pointerType:'mouse',bubbles:true,cancelable:true}))",
				),
				false,
			);
			await output(page, "\x1b[?1000l");

			// Output while the word is selected scrolls the program's screen but not the drawn rows.
			await page.evaluate(
				`(()=>{const selection=getSelection();selection.removeAllRanges();selection.addRange(${word});})()`,
			);
			await delay(100);
			const lines = Array.from({ length: 60 }, (_, index) => `flood-${index}\r\n`).join("");
			await output(page, lines);
			await delay(300);
			assert.equal(await page.evaluate<string>("getSelection().toString()"), "select-me");
			assert.equal(
				await page.evaluate<boolean>(
					"document.querySelector('.terminal-content').textContent.includes('flood-59')",
				),
				false,
			);
			const copy = `(()=>{const data=new DataTransfer();document.querySelector('.terminal-row').dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain')})()`;
			assert.equal(await page.evaluate<string>(copy), "select-me");
			// The selection ends (Copy, a tap): what arrived meanwhile is drawn.
			await page.evaluate("getSelection().removeAllRanges()");
			await page.wait("document.querySelector('.terminal-content').textContent.includes('flood-59')");

			// A line longer than the terminal is wide copies as one line; rows lose the blanks that fill them.
			const long = `wrap-${"a".repeat(120)}-end`;
			await output(page, `\x1b[2J\x1b[H${long}\r\nnext   \r\n`);
			await page.wait("document.querySelector('.terminal-content').textContent.includes('next')");
			const wrapped = await page.evaluate<number>(
				"[...document.querySelectorAll('.terminal-row')].filter(row=>row.hasAttribute('data-wrapped')).length",
			);
			assert(wrapped >= 2, `${wrapped} wrapped rows`);
			await page.evaluate(
				`(()=>{const rows=[...document.querySelectorAll('.terminal-row')];const last=rows.findIndex(row=>row.textContent.startsWith('next'));
				const range=document.createRange();range.setStart(rows[0],0);range.setEnd(rows[last],rows[last].childNodes.length);
				const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`,
			);
			assert.equal(await page.evaluate<string>(copy), `${long}\nnext`);
			await page.evaluate("getSelection().removeAllRanges()");
		}),
);
