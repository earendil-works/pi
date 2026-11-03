// Tests of the terminal launcher (slice 11 §4, decision "Slice 11, P8") with a kit app's terminal surface: it signs in
// with the owner token file or by pairing, runs the app's terminal code in the sandbox with the plugins' scripts, relays
// its Chord link, confirms its actions on its own prompt, applies a plugin edit in place, and ends with its exit code.
// Run under Node 26.5.1 or later (`TUI_NODE`); skipped without one.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Sessions } from "../../../src/node/app/index.ts";
import { requireSandboxNode, terminalFile } from "../../../src/node/tui/index.ts";
import { send } from "../http/support.ts";
import { Launched, linesPlugin, TUI_NODE, tuiApp } from "./support.ts";

/** The terminal's modes back to the shell's, the scroll region and autowrap included (Opus E11). */
const RESET =
	"\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b[?7h\x1b[?1049l\x1b[0m";

describe("the Node it needs", () => {
	it("refuses a Node older than 26.5.1 with a clear error", () => {
		expect(() => requireSandboxNode("24.4.1")).toThrow(
			"needs Node 26.5.1 or later for its sandbox (this is Node 24.4.1)",
		);
		expect(() => requireSandboxNode("26.5.0")).toThrow();
		expect(() => requireSandboxNode("26.5.1")).not.toThrow();
		expect(() => requireSandboxNode("27.0.0")).not.toThrow();
	});
});

describe("the files the sandbox may fetch", () => {
	it("are the terminal surface's, after dot segments and encodings resolve (Opus M2, Fable L1)", () => {
		const server = new URL("http://127.0.0.1:8788");
		expect(terminalFile("/_chord/tui/plugin/@test~lines.abc.js", server)).toBe(
			"/_chord/tui/plugin/@test~lines.abc.js",
		);
		expect(terminalFile("/_chord/tui/plugins.0123.js", server)).toBe("/_chord/tui/plugins.0123.js");
		for (const path of [
			"/_chord/tui/../../_chord/export/x",
			"/_chord/tui/%2e%2e/%2e%2e/admin",
			"/_chord/tui/..\\..\\admin",
			"//evil.example/_chord/tui/x.js",
			"http://evil.example/_chord/tui/x.js",
			"/_chord/tui/x.js?y=1",
			"/_chord/tui/a/b/c.js",
			"/files/general/1",
			42,
		]) {
			expect(() => terminalFile(path, server)).toThrow("no terminal file");
		}
	});
});

describe.skipIf(TUI_NODE === undefined)("a terminal client", () => {
	it("runs the app's terminal code with the plugins, confirms its actions, applies an edit in place, exits", async () => {
		const { app, port, root } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/ready 80x24 \x1b\[38;2;76;154;255mthemed\x1b\[39m/);
			await launched.waitFor(/lines: \["plugin v1 tried=\d+ escaped=none"\]/);
			// Copying: the launcher's prompt, then OSC 52 from the launcher itself.
			launched.type("c");
			await launched.waitFor(/Copy these 15 characters \(1 line\)\? \[y\/N\]/);
			expect(launched.output).toContain("  hello clipboard");
			await launched.answer("y");
			await launched.waitFor(new RegExp(`\\x1b\\]52;c;${Buffer.from("hello clipboard").toString("base64")}\\x07`));
			await launched.waitFor(/copied true/);
			launched.type("o");
			await launched.waitFor(/Open example\.com in the browser\? \[y\/N\]/);
			await launched.answer("n");
			await launched.waitFor(/opened false/);
			expect(launched.output).not.toContain("(opener");
			// An edit of the terminal plugin applies in place: the sandbox fetches the new script through the launcher.
			await writeFile(join(root, "lines", "tui.ts"), linesPlugin("plugin v2")["tui.ts"]!);
			while (!app.plugins.state.value.dirty.includes("@test/lines"))
				await new Promise((resolve) => setTimeout(resolve, 10));
			const result = await app.applyChanges(context);
			expect(result.steps.map(({ name }) => name)).toEqual(["server", "tui"]);
			await launched.waitFor(/lines: \["plugin v2 tried=\d+ escaped=none"\]/);
			expect(launched.output).not.toContain("ready 80x24 \x1b[38;2;76;154;255mthemed\x1b[39m\r\nready");
			launched.type("q");
			expect(await launched.exited).toBe(3);
			// The terminal's modes back to the shell's.
			expect(launched.output.endsWith(RESET)).toBe(true);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("holds the sandbox's frames while its prompt is open, and refuses a second request meanwhile (Fable H1, Opus M1)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/lines: \[/);
			launched.type("x");
			await launched.waitFor(/Attach this file\? \[y\/N\]/);
			await new Promise((resolve) => setTimeout(resolve, 300));
			// The fake prompt the sandbox wrote at once is not on the terminal while the real one waits.
			expect(launched.output).not.toContain("FAKE");
			await launched.answer("n");
			await launched.waitFor(/attached false/);
			expect(launched.output.indexOf("FAKE")).toBeGreaterThan(launched.output.indexOf("Attach this file?"));
			launched.type("z");
			await launched.waitFor(/Copy these 3 characters/);
			await launched.answer("n");
			await launched.waitFor(/copies: done false \/ refused terminal: a prompt is open/);
			launched.type("q");
			expect(await launched.exited).toBe(3);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("draws its prompt in its own colours and ignores keys typed before it appeared (Opus E4)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/lines: \[/);
			// The sandbox leaves concealed black on black, asks, and a "y" typed for it arrives with the prompt.
			launched.type("h");
			await new Promise((resolve) => setTimeout(resolve, 30));
			launched.type("y");
			await launched.waitFor(/Copy these 6 characters/);
			const prompt = launched.output.slice(launched.output.lastIndexOf("\x1b[?2026l\x1b[s"));
			expect(prompt).toMatch(/^\x1b\[\?2026l\x1b\[s\x1b\[\d+;1H\x1b\[0;30;47m\x1b\[2K {3}hidden /);
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(launched.output).not.toContain("hidden copied");
			await launched.answer("n");
			await launched.waitFor(/hidden copied false/);
			launched.type("q");
			expect(await launched.exited).toBe(3);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("survives what the sandbox sends to break it, and gives the terminal back when the sandbox dies (Opus E3)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/lines: \[/);
			launched.type("w");
			await launched.waitFor(/survived: huge write RangeError, huge bytes RangeError/);
			// Still running: a request still answered.
			launched.type("o");
			await launched.waitFor(/Open example\.com in the browser\?/);
			await launched.answer("n");
			await launched.waitFor(/opened false/);
			// The sandbox's process ends: the client ends with 1, the terminal's modes reset.
			launched.type("k");
			expect(await launched.exited).toBe(1);
			expect(launched.output.endsWith(RESET)).toBe(true);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("answers eight requests at once, refuses more, and ignores SIGUSR1 (Opus E10, E8)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/lines: \[/);
			// Twelve sent at once: the first eight answered, the rest refused (one answered before the next arrives counts
			// as answered).
			const flood = async (): Promise<void> => {
				const mark = launched.output.length;
				launched.type("f");
				const [line] = await launched.waitFor(/requests: [^\r]*\r\n/, mark);
				const [, answered, refused] = /^requests: (\d+) answered, (\d+) terminal: too many requests at once/.exec(
					line,
				)!;
				expect(Number(answered)).toBeGreaterThanOrEqual(8);
				expect(Number(answered) + Number(refused)).toBe(12);
			};
			await flood();
			// A signal the sandbox may send its launcher opens no inspector.
			process.kill(launched.child.pid!, "SIGUSR1");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(launched.output).not.toContain("Debugger listening");
			await flood();
			launched.type("q");
			expect(await launched.exited).toBe(3);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("ends on Ctrl-C while its prompt is open, whatever the sandbox asks (Opus E11)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		try {
			await launched.waitFor(/lines: \[/);
			launched.type("c");
			await launched.waitFor(/Copy these 15 characters/);
			launched.type("\x03");
			expect(await launched.exited).toBe(130);
			expect(launched.output.endsWith(RESET)).toBe(true);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("ends on three Ctrl-C within a second, though the sandbox ignores them (Opus R2)", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "token", app.ownerTokenFile]);
		const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		try {
			await launched.waitFor(/lines: \[/);
			// The fixture's terminal code does nothing with Ctrl-C. One, then two more over a second later: still running.
			launched.type("\x03");
			await pause(1100);
			launched.type("\x03");
			await pause(50);
			launched.type("\x03");
			await pause(300);
			launched.type("o");
			await launched.waitFor(/Open example\.com in the browser\?/);
			await launched.answer("n");
			await launched.waitFor(/opened false/);
			// Three within a second: the client ends, the terminal reset.
			for (let index = 0; index < 3; index++) {
				launched.type("\x03");
				await pause(50);
			}
			expect(await launched.exited).toBe(130);
			expect(launched.output.endsWith(RESET)).toBe(true);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);

	it("pairs with the server: the code shown, approved by the owner, then the client runs", async () => {
		const { app, port } = await tuiApp();
		const launched = new Launched([`http://127.0.0.1:${port}`, "pair", "test terminal"]);
		try {
			const [, code] = await launched.waitFor(/Pairing code ([A-Z0-9]{4}-[A-Z0-9]{4}): approve it at /);
			const { token } = await app.host.root(
				async (ctx) =>
					(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "o", kind: "device" }, ctx),
				context,
			);
			expect(
				(await send(port, "POST", `/_chord/pair/${code}`, { headers: { authorization: `Bearer ${token}` } }))
					.status,
			).toBe(200);
			await launched.waitFor(/lines: \["plugin v1 tried=\d+ escaped=none"\]/);
			const sessions = await app.host.get(Sessions, {}, context);
			expect(sessions.list.value.map(({ label }) => label)).toContain("test terminal");
			sessions.release();
			launched.type("q");
			expect(await launched.exited).toBe(3);
		} finally {
			launched.kill();
			await app.close(context);
		}
	}, 60_000);
});
