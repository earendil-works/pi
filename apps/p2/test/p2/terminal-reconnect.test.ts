// A terminal whose socket drops gets a new one and keeps working (Terminal.tsx with src/web/reconnect.ts).

import { test } from "node:test";
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
	"a dropped terminal socket is replaced and typing reaches the shell again",
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
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
			const page = browser;
			await page.call("Page.addScriptToEvaluateOnNewDocument", {
				source: `
			window.terminalSockets=[];
			window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){
				const socket=Reflect.construct(Target,args);
				if(String(args[0]).includes('/terminal'))window.terminalSockets.push(socket);
				return socket;
			}});`,
			});
			await page.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
			await page.wait("document.querySelector('button[aria-label=Terminal]')");
			await page.evaluate("document.querySelector('button[aria-label=Terminal]').click()");
			const prompt = "[...document.querySelectorAll('.terminal-row')].some(row => /[$#]/.test(row.textContent))";
			await page.wait(prompt);
			await page.wait("window.terminalSockets.length === 1 && window.terminalSockets[0].readyState === 1");

			await page.evaluate("window.terminalSockets[0].close()");
			await page.wait("window.terminalSockets.length === 2 && window.terminalSockets[1].readyState === 1");
			await page.wait(prompt);

			await page.evaluate("document.querySelector('.terminal-input').focus()");
			await page.call("Input.insertText", { text: "echo reconnected-$((40+2))" });
			await page.call("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				text: "\r",
			});
			await page.call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
			});
			// Only the shell computes 42: the keys went over the new socket.
			await page.wait(
				"[...document.querySelectorAll('.terminal-row')].some(row => row.textContent.includes('reconnected-42'))",
			);
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
