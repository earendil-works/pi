// The terminal host's calls for the agent's terminal tool, against a real host and pi-env daemon (skipped without a
// daemon build): opens and inputs done once per key, the read cursor and its ring overflow, waits (quiet, match, exit,
// timeout, cancel), plain text, the alternate screen as screen text, captures, session list pushes to the viewers,
// the agent's terminal cap, closing a session, and an outdated host refusing calls.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import {
	encodeFrame,
	type HostCall,
	type HostResult,
	readFrames,
	type TerminalEvent,
	type TerminalRead,
	type TerminalRequest,
} from "../../plugins/terminals/protocol.ts";
import { HostCalls, OUTDATED_HOST } from "../../plugins/terminals/service.ts";
import { APP } from "./helpers.ts";

const ESC = "\x1b";

let unavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	unavailable = error instanceof Error ? error.message : "No pi-env daemon with terminal support";
}

/** A host connection that records events and makes calls. */
async function client(directory: string) {
	const socket: Socket = await connectTerminalHost(directory, APP);
	const events: TerminalEvent[] = [];
	const replies = new Map<number, (event: Extract<TerminalEvent, { type: "reply" }>) => void>();
	let next = 1;
	readFrames(socket, (frame) => {
		if (frame instanceof Uint8Array) return;
		const event = frame as TerminalEvent;
		if (event.type === "reply") replies.get(event.id)?.(event);
		else events.push(event);
	});
	const send = (message: TerminalRequest) => socket.write(encodeFrame(message));
	/** Starts a call: its id, and its result (rejecting with the host's error). */
	const start = (call: HostCall) => {
		const id = next++;
		const result = new Promise<HostResult>((resolve, reject) => {
			replies.set(id, (event) => ("error" in event ? reject(new Error(event.error)) : resolve(event.result)));
		});
		send({ type: "call", id, call });
		return { id, result };
	};
	const call = (request: HostCall) => start(request).result;
	const read = async (request: Omit<Extract<HostCall, { op: "read" }>, "op">): Promise<TerminalRead> => {
		const result = await call({ op: "read", ...request });
		assert.equal(result.kind, "read");
		return result as Extract<HostResult, { kind: "read" }>;
	};
	return { socket, events, send, start, call, read };
}

test("terminal host: the agent's calls", { timeout: 120_000, skip: unavailable }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-agent-terminals-"));
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-agent-terminal-cwd-")));
	const shell = process.env.SHELL;
	// The host and its shells inherit this: a plain shell, without the developer's rc files.
	process.env.SHELL = "/bin/sh";
	const viewer = await client(directory);
	const agent = await client(directory);
	const open = async (sessionId: string, key: string, command?: string, name?: string) => {
		const result = await agent.call({
			op: "open",
			sessionId,
			key,
			cwd,
			env: null,
			cols: 60,
			rows: 10,
			...(command ? { command } : {}),
			...(name ? { name } : {}),
		});
		assert.equal(result.kind, "terminal");
		return (result as Extract<HostResult, { kind: "terminal" }>).terminal;
	};
	const send = (target: string, key: string, keys: string[], literal = false, sessionId = "s1") =>
		agent.call({ op: "send", sessionId, key, target, keys, literal });
	const prompt = { until: "match", pattern: "[$#] $", timeoutMs: 10_000 } as const;
	try {
		await t.test("opens once per key, types keys once per key, reads from the cursor", async () => {
			viewer.send({ type: "list", sessionId: "s1" });
			const terminal = await open("s1", "open-1", "printf 'hi-%s\\n' there", "dev");
			assert.equal(terminal.index, 1);
			assert.equal(terminal.agent, true);
			assert.equal(terminal.name, "dev");
			assert.equal((await open("s1", "open-1")).id, terminal.id);
			// The viewer that listed the session hears of it.
			await poll(() =>
				viewer.events.some(
					(event) => event.type === "terminals" && event.terminals.some((each) => each.id === terminal.id),
				),
			);
			const first = await agent.read({
				sessionId: "s1",
				target: "dev",
				// The program's output, then the next prompt.
				wait: { until: "match", pattern: "^hi-there\\n.*[$#] $", timeoutMs: 10_000 },
			});
			assert.equal(first.waited, "match", JSON.stringify(first.text));
			assert.equal(first.from, 0);
			assert.match(first.text, /^hi-there$/m);
			const cursor = await agent.call({ op: "cursor", sessionId: "s1", target: ":1" });
			assert.equal(cursor.kind, "cursor");
			const from = (cursor as Extract<HostResult, { kind: "cursor" }>).offset;
			assert.ok(from > 0);
			// The same key twice: typed once.
			await send("1", "send-1", ["echo o''ne", "Enter"]);
			await send("1", "send-1", ["echo o''ne", "Enter"]);
			const typed = await agent.read({
				sessionId: "s1",
				target: "1",
				wait: { ...prompt, pattern: "one\\n.*[$#] $" },
			});
			assert.equal(typed.from, from);
			assert.equal(typed.text.match(/^one$/gm)?.length, 1);
			// A read repeated from the same start (a replayed call) gets the same output again.
			const again = await agent.read({ sessionId: "s1", target: "1", from });
			assert.ok(again.text.startsWith(typed.text));
			// The cursor moved past it: nothing new.
			assert.equal((await agent.read({ sessionId: "s1", target: "1" })).text, "");
			const listed = await agent.call({ op: "list", sessionId: "s1" });
			assert.deepEqual(listed.kind === "list" ? listed.windows.map((window) => window.terminal.id) : [], [
				terminal.id,
			]);
			await assert.rejects(send("9", "send-2", ["x"]), /can't find window: 9/);
			await assert.rejects(send("1", "send-3", ["x"], false, "s2"), /can't find window: 1/);
		});

		await t.test("waits: match, quiet, timeout with the foreground job, cancel, exit", async () => {
			await send("1", "wait-1", ["sleep 0.3; echo la''te", "Enter"]);
			const late = await agent.read({
				sessionId: "s1",
				target: "1",
				wait: { until: "match", pattern: "^late", timeoutMs: 5000 },
			});
			assert.equal(late.waited, "match");
			assert.equal(
				(
					await agent.read({
						sessionId: "s1",
						target: "1",
						wait: { until: "quiet", quietMs: 200, timeoutMs: 5000 },
					})
				).waited,
				"quiet",
			);
			await send("1", "wait-2", ["sleep 30", "Enter"]);
			const timedOut = await agent.read({
				sessionId: "s1",
				target: "1",
				wait: { until: "match", pattern: "never", timeoutMs: 500 },
			});
			assert.equal(timedOut.waited, "timeout");
			assert.match(timedOut.foreground ?? "", /sleep/);
			const waiting = agent.start({
				op: "read",
				sessionId: "s1",
				target: "1",
				wait: { until: "exit", timeoutMs: 60_000 },
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			agent.send({ type: "cancel", id: waiting.id });
			await assert.rejects(waiting.result, /cancelled/);
			await send("1", "wait-3", ["C-c"]);
			await agent.read({ sessionId: "s1", target: "1", wait: prompt });
			await send("1", "wait-4", ["exit 3", "Enter"]);
			const exited = await agent.read({ sessionId: "s1", target: "1", wait: { until: "exit", timeoutMs: 10_000 } });
			assert.equal(exited.waited, "exit");
			assert.deepEqual(exited.terminal.exited, { code: 3 });
			assert.equal(exited.foreground, undefined);
			await assert.rejects(send("1", "wait-5", ["x"]), /window 1 has exited/);
		});

		await t.test("plain text, the alternate screen, captures and ring overflow", async () => {
			const terminal = await open("s1", "open-2");
			// The exited window 1 keeps its number: this one is 2.
			assert.equal(terminal.index, 2);
			await agent.read({ sessionId: "s1", target: "2", wait: prompt });
			await send("2", "plain-1", ["printf 'a\\033[31mred\\033[0m\\r\\n10%%\\r50%%\\r100%%\\n'", "Enter"]);
			const plain = await agent.read({ sessionId: "s1", target: "2", wait: { ...prompt, pattern: "100%\\n" } });
			assert.match(plain.text, /^ared$/m);
			assert.match(plain.text, /^100%$/m);
			assert.ok(!plain.text.includes("\x1b") && !plain.text.includes("10%\r"));
			// A full-screen program: the read returns its screen.
			await send("2", "plain-2", [
				"printf '\\033[?1049h\\033[H\\033[2JFULL SCREEN\\n'; sleep 1; printf '\\033[?1049l'",
				"Enter",
			]);
			const full = await agent.read({
				sessionId: "s1",
				target: "2",
				wait: { until: "match", pattern: "^FULL SCREEN$", timeoutMs: 5000 },
			});
			assert.equal(full.screen?.split("\n")[0], "FULL SCREEN");
			await agent.read({ sessionId: "s1", target: "2", wait: { ...prompt, timeoutMs: 5000 } });
			assert.equal((await agent.read({ sessionId: "s1", target: "2" })).screen, undefined);
			await send("2", "plain-3", ["clear; seq 1 100; printf '\\033[32mgreen\\033[0m\\n'", "Enter"]);
			await agent.read({ sessionId: "s1", target: "2", wait: { ...prompt, pattern: "green\\n.*[$#] $" } });
			const capture = async (scrollback: number, escapes = false) => {
				const result = await agent.call({ op: "capture", sessionId: "s1", target: "2", scrollback, escapes });
				return result.kind === "capture" ? result.text : "";
			};
			const screen = (await capture(0)).split("\n");
			// Ten rows: the last numbers, the green line and the prompt.
			assert.ok(screen.length <= 10);
			assert.deepEqual(screen.slice(-3, -1), ["100", "green"]);
			assert.match(screen.at(-1) ?? "", /[$#]$/);
			const scrolled = (await capture(20)).split("\n");
			assert.equal(scrolled.length, screen.length + 20);
			assert.equal(scrolled[0], String(Number(screen[0]) - 20));
			assert.match(await capture(0, true), new RegExp(`${ESC}\\[0;38;2;\\d+;\\d+;\\d+mgreen${ESC}\\[0m`));
			// More output than the ring keeps: the read reports what it lost and returns the last part.
			await send("2", "plain-4", ["head -c 1500000 /dev/zero | tr '\\0' x; echo; echo E''ND", "Enter"]);
			const flood = await agent.read({
				sessionId: "s1",
				target: "2",
				wait: { until: "match", pattern: "^END$", timeoutMs: 30_000 },
			});
			assert.ok(flood.skipped > 0, `skipped ${flood.skipped}`);
			assert.ok(flood.truncated > 0, `truncated ${flood.truncated}`);
			assert.match(flood.text, /^END$/m);
		});

		await t.test("the agent's cap, closing once per key, closing a session", async () => {
			const other = await client(directory);
			other.send({ type: "list", sessionId: "s2" });
			// The owner's own terminals do not count against the agent's cap.
			other.send({ type: "open", sessionId: "s2", cwd, env: null, cols: 40, rows: 5 });
			await poll(() => other.events.some((event) => event.type === "attached"));
			for (let index = 0; index < 8; index++) await open("s2", `cap-${index}`);
			await assert.rejects(open("s2", "cap-8"), /the agent has 8 terminals running in this session already/);
			const closed = await agent.call({ op: "close", sessionId: "s2", key: "close-1", target: "2" });
			assert.equal(closed.kind, "closed");
			assert.deepEqual(await agent.call({ op: "close", sessionId: "s2", key: "close-1", target: "2" }), closed);
			await assert.rejects(
				agent.call({ op: "close", sessionId: "s2", key: "close-2", target: "2" }),
				/can't find window: 2/,
			);
			await open("s2", "cap-8");
			assert.deepEqual(await agent.call({ op: "closeSession", sessionId: "s2" }), { kind: "done" });
			const list = await agent.call({ op: "list", sessionId: "s2" });
			assert.deepEqual(list, { kind: "list", windows: [] });
			await poll(() => {
				const last = other.events.filter((event) => event.type === "terminals").at(-1);
				return last?.type === "terminals" && last.terminals.length === 0;
			});
			// Session s1 is untouched.
			assert.equal((await agent.call({ op: "list", sessionId: "s1" })).kind, "list");
			other.socket.destroy();
		});

		await t.test("a host running other code refuses calls", async () => {
			const calls = new HostCalls(directory, APP, "another-version");
			await assert.rejects(calls.call({ op: "list", sessionId: "s1" }), new Error(OUTDATED_HOST));
			calls.close();
		});
	} finally {
		viewer.socket.destroy();
		agent.socket.destroy();
		const last = await client(directory);
		last.send({ type: "shutdown" });
		await new Promise((resolve) => last.socket.once("close", resolve));
		if (shell === undefined) delete process.env.SHELL;
		else process.env.SHELL = shell;
		await rm(directory, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

async function poll(check: () => boolean, timeout = 10_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
