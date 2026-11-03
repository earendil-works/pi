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

test(
	"touch terminal native paste target, clipboard key, denial, scrolling and Copy selection",
	{ timeout: 60000, skip: !browserTests ? "no Chromium" : unavailable },
	async () => {
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
			await page.wait("document.querySelector('button[aria-label=\"Paste into terminal\"]')");
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
	},
);
