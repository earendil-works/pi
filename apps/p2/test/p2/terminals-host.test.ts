import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { Ghostty } from "../../plugins/terminals/ghostty.ts";
import {
	encodeFrame,
	readFrames,
	TERMINAL_OUTPUT_WINDOW,
	type TerminalEvent,
	type TerminalRequest,
} from "../../plugins/terminals/protocol.ts";
import { APP } from "./helpers.ts";

let unavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	unavailable = error instanceof Error ? error.message : "No pi-env daemon with terminal support";
}
const ghostty = await Ghostty.load(
	await readFile(new URL("../../plugins/terminals/vendor/ghostty/ghostty-vt.wasm", import.meta.url)),
);

/** A host connection that records events and output. */
async function client(directory: string) {
	const socket: Socket = await connectTerminalHost(directory, APP);
	const events: TerminalEvent[] = [];
	const output: Uint8Array[] = [];
	const waiters: (() => void)[] = [];
	readFrames(socket, (frame) => {
		if (frame instanceof Uint8Array) output.push(frame);
		else events.push(frame as TerminalEvent);
		for (const waiter of waiters.splice(0)) waiter();
	});
	const until = async <T>(check: () => T | undefined, timeout = 10_000): Promise<T> => {
		const deadline = Date.now() + timeout;
		for (;;) {
			const value = check();
			if (value !== undefined) return value;
			if (Date.now() > deadline)
				throw new Error(`Timed out; output: ${JSON.stringify(Buffer.concat(output).toString("utf8"))}`);
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 100);
			});
		}
	};
	return {
		socket,
		events,
		output,
		until,
		text: () => Buffer.concat(output).toString("utf8"),
		send: (message: TerminalRequest | Uint8Array) => socket.write(encodeFrame(message)),
	};
}

test(
	"terminals: run in the host, survive disconnects and come back as snapshots",
	{ timeout: 60_000, skip: unavailable },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminals-"));
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-terminal-cwd-")));
		const shell = process.env.SHELL;
		// The host and its shells inherit this: a plain shell, without the developer's rc files.
		process.env.SHELL = "/bin/sh";
		const first = await client(directory);
		try {
			first.send({ type: "open", sessionId: "s1", cwd, env: null, cols: 40, rows: 10 });
			const attached = await first.until(() =>
				first.events.find(
					(event): event is Extract<TerminalEvent, { type: "attached" }> => event.type === "attached",
				),
			);
			const id = attached.terminal.id;
			// Typed before the shell's first prompt, the line is echoed first and the prompt then precedes the output
			// ("$ in /..."), as in any terminal; a slow shell start (Termux) lost that race.
			await first.until(() => (/[$#] $/.test(first.text()) ? true : undefined));
			first.send(new TextEncoder().encode("printf 'in %s\\n' \"$PWD\"; echo $TERM\n"));
			await first.until(() => (first.text().includes(`in ${cwd}`) ? true : undefined));
			await first.until(() => (first.text().includes("xterm-256color") ? true : undefined));
			first.socket.destroy();

			// A new connection lists it and attaches: the snapshot has the earlier output.
			const second = await client(directory);
			second.send({ type: "list", sessionId: "s1" });
			const list = await second.until(() =>
				second.events.find((event): event is Extract<TerminalEvent, { type: "list" }> => event.type === "list"),
			);
			assert.deepEqual(
				list.terminals.map((terminal) => terminal.id),
				[id],
			);
			second.send({ type: "list", sessionId: "other" });
			await second.until(() =>
				second.events.filter((event) => event.type === "list").length === 2 ? true : undefined,
			);
			assert.deepEqual(second.events.at(-1), { type: "list", terminals: [] });
			second.send({ type: "attach", terminalId: id });
			const snapshot = await second.until(() => second.output[0]);
			const vt = ghostty.terminal({ cols: 40, rows: 10, scrollback: 100 });
			vt.write(snapshot);
			const screen = vt
				.frame(true)
				.changed.map((row) => row.cells.map((cell) => cell.text || " ").join(""))
				.join("\n");
			// Long lines wrap at 40 columns.
			assert.match(screen, /^in \//m);
			assert.match(screen, /^xterm-256color/m);
			vt.free();

			// Resizing reaches the program; its exit is reported.
			second.send({ type: "resize", cols: 50, rows: 12 });
			second.send(new TextEncoder().encode("stty size; exit 7\n"));
			await second.until(() => (second.text().includes("12 50") ? true : undefined));
			const exited = await second.until(() =>
				second.events.find(
					(event): event is Extract<TerminalEvent, { type: "changed" }> =>
						event.type === "changed" && event.terminal.exited !== undefined,
				),
			);
			assert.deepEqual(exited.terminal.exited, { code: 7 });

			second.send({ type: "close" });
			await second.until(() => second.events.find((event) => event.type === "closed"));
			second.send({ type: "list", sessionId: "s1" });
			await second.until(() =>
				second.events.filter((event) => event.type === "list").length === 3 ? true : undefined,
			);
			assert.deepEqual(second.events.at(-1), { type: "list", terminals: [] });
		} finally {
			// Also after a failure: the detached host would keep running with its terminals.
			const last = await client(directory);
			last.send({ type: "shutdown" });
			await new Promise((resolve) => last.socket.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
			first.socket.destroy();
			await rm(directory, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test("terminals: closing asks first while the shell runs a job", { timeout: 60_000, skip: unavailable }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminals-busy-"));
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-terminal-busy-cwd-")));
	const shell = process.env.SHELL;
	process.env.SHELL = "/bin/sh";
	const viewer = await client(directory);
	const opened = async () => {
		const count = viewer.events.filter((event) => event.type === "attached").length;
		viewer.send({ type: "open", sessionId: "s1", cwd, env: null, cols: 80, rows: 10 });
		await viewer.until(() =>
			viewer.events.filter((event) => event.type === "attached").length > count ? true : undefined,
		);
	};
	const type = (text: string) => viewer.send(new TextEncoder().encode(text));
	try {
		// At the prompt: closes at once.
		await opened();
		type("echo PRO''MPT\n");
		await viewer.until(() => (viewer.text().includes("PROMPT") ? true : undefined));
		viewer.send({ type: "close" });
		await viewer.until(() => viewer.events.find((event) => event.type === "closed"));

		// A job in front: the host names it and keeps the terminal until a forced close.
		await opened();
		// The job prints once it runs in front of the terminal; the shell hands it over before that.
		type("sh -c 'echo RUN''NING; exec sleep 100'\n");
		await viewer.until(() => (viewer.text().includes("RUNNING") ? true : undefined));
		viewer.send({ type: "close" });
		const busy = await viewer.until(() =>
			viewer.events.find((event): event is Extract<TerminalEvent, { type: "busy" }> => event.type === "busy"),
		);
		// The job's name: its shell, or `sleep` once it has run `exec`.
		if (process.platform === "darwin" || process.platform === "linux") assert.ok(busy.program);
		assert.equal(viewer.events.filter((event) => event.type === "closed").length, 1);
		viewer.send({ type: "close", force: true });
		await viewer.until(() =>
			viewer.events.filter((event) => event.type === "closed").length === 2 ? true : undefined,
		);
		viewer.send({ type: "list", sessionId: "s1" });
		const list = await viewer.until(() =>
			viewer.events.find((event): event is Extract<TerminalEvent, { type: "list" }> => event.type === "list"),
		);
		assert.deepEqual(list.terminals, []);
	} finally {
		if (shell === undefined) delete process.env.SHELL;
		else process.env.SHELL = shell;
		viewer.socket.destroy();
		const last = await client(directory);
		last.send({ type: "shutdown" });
		await new Promise((resolve) => last.socket.once("close", resolve));
		await rm(directory, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test(
	"terminals: programs see the viewer's colors and hear about light/dark switches",
	{ timeout: 60_000, skip: unavailable },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminals-theme-"));
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-terminal-theme-cwd-")));
		const shell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		const viewer = await client(directory);
		try {
			viewer.send({ type: "theme", foreground: 0x1d1b19, background: 0xfbfaf8, scheme: "light" });
			viewer.send({ type: "open", sessionId: "s1", cwd, env: null, cols: 80, rows: 10 });
			const type = (text: string) => viewer.send(new TextEncoder().encode(text));
			type("echo fgbg=$COLORFGBG\n");
			await viewer.until(() => (viewer.text().includes("fgbg=0;15") ? true : undefined));
			// A program asks for the background color (OSC 11) and reads the answer from its input.
			type(
				"stty raw -echo; printf '\\033]11;?\\007'; r=$(dd bs=1 count=24 2>/dev/null); stty sane; printf 'got%s\\n' \"$r\" | tr -d '\\033\\007'\n",
			);
			await viewer.until(() => (viewer.text().includes("got]11;rgb:fbfb/fafa/f8f8") ? true : undefined));
			// A program that enabled mode 2031 is told when the viewer switches to dark.
			type(
				"stty raw -echo; printf '\\033[?2031hREADY'; r=$(dd bs=1 count=9 2>/dev/null); stty sane; printf 'scheme%s\\n' \"$r\" | tr -d '\\033'\n",
			);
			// The program's output, not the echoed command line.
			await viewer.until(() => (viewer.text().includes("\x1b[?2031hREADY") ? true : undefined));
			viewer.send({ type: "theme", foreground: 0xe6e6e6, background: 0x141414, scheme: "dark" });
			await viewer.until(() => (viewer.text().includes("scheme[?997;1n") ? true : undefined));
		} finally {
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
			viewer.socket.destroy();
			const last = await client(directory);
			last.send({ type: "shutdown" });
			await new Promise((resolve) => last.socket.once("close", resolve));
			await rm(directory, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"terminals: a viewer that falls behind stops receiving output and resyncs with a snapshot",
	{ timeout: 60_000, skip: unavailable },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminals-flow-"));
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-terminal-cwd-")));
		const shell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		const viewer = await client(directory);
		const bytes = () => viewer.output.reduce((sum, chunk) => sum + chunk.length, 0);
		try {
			viewer.send({ type: "open", sessionId: "s1", cwd, env: null, cols: 40, rows: 10 });
			await viewer.until(() => viewer.events.find((event) => event.type === "attached"));
			await viewer.until(() => (/[$#] $/.test(viewer.text()) ? true : undefined));
			// About 8 MiB of output, then a marker once the flood is over.
			viewer.send(
				new TextEncoder().encode("yes 0123456789abcdef0123456789abcdef | head -n 230000; echo flood-done\n"),
			);
			await viewer.until(() => (bytes() > TERMINAL_OUTPUT_WINDOW ? true : undefined));
			// Without acknowledgements the host stops after one window plus the chunk that crossed it.
			await new Promise((resolve) => setTimeout(resolve, 2000));
			const received = bytes();
			assert(received < 2 * TERMINAL_OUTPUT_WINDOW, `received ${received} bytes without acknowledging`);
			assert.equal(viewer.events.filter((event) => event.type === "attached").length, 1);

			// Acknowledging everything resyncs: `attached` again and a snapshot of the screen as it is now.
			viewer.send({ type: "ack", bytes: received });
			await viewer.until(() =>
				viewer.events.filter((event) => event.type === "attached").length === 2 ? true : undefined,
			);
			const snapshot = await viewer.until(() => (viewer.output.length > 0 ? viewer.output.at(-1) : undefined));
			viewer.send({ type: "ack", bytes: bytes() - received });
			await viewer.until(() => (viewer.text().includes("flood-done") ? true : undefined), 30_000);
			assert(snapshot.length > 0);
		} finally {
			const last = await client(directory);
			last.send({ type: "shutdown" });
			await new Promise((resolve) => last.socket.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
			viewer.socket.destroy();
			await rm(directory, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test(
	"terminals: a snapshot larger than the output window does not resync a viewer that keeps up",
	{ timeout: 60_000, skip: unavailable },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminals-snapshot-"));
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "p2-terminal-cwd-")));
		const shell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		const writer = await client(directory);
		let viewer: Awaited<ReturnType<typeof client>> | undefined;
		const timers: NodeJS.Timeout[] = [];
		/** Acknowledges everything the connection receives, as the web terminal does; returns the bytes received. */
		const acknowledging = (connection: Awaited<ReturnType<typeof client>>) => {
			let acked = 0;
			const received = () => connection.output.reduce((sum, chunk) => sum + chunk.length, 0);
			timers.push(
				setInterval(() => {
					const bytes = received() - acked;
					if (bytes === 0) return;
					acked += bytes;
					connection.send({ type: "ack", bytes });
				}, 10),
			);
			return received;
		};
		acknowledging(writer);
		try {
			writer.send({ type: "open", sessionId: "s1", cwd, env: null, cols: 80, rows: 24 });
			const attached = await writer.until(() =>
				writer.events.find(
					(event): event is Extract<TerminalEvent, { type: "attached" }> => event.type === "attached",
				),
			);
			await writer.until(() => (/[$#] $/.test(writer.text()) ? true : undefined));
			// 400 lines with a different truecolor foreground per cell: the scrollback snapshot is several windows large.
			// The markers are computed by the shell, so the echoed command line does not contain them.
			writer.send(
				new TextEncoder().encode(
					'awk \'BEGIN{for(i=0;i<400;i++){s="";for(j=0;j<79;j++)s=s sprintf("\\033[38;2;%d;%d;%dmx",i%256,j*3,(i*j)%256);print s "\\033[0m"}}\'; echo colors-$((1+1))\n',
				),
			);
			await writer.until(() => (writer.text().includes("colors-2") ? true : undefined), 30_000);

			const current = await client(directory);
			viewer = current;
			const received = acknowledging(current);
			current.send({ type: "attach", terminalId: attached.terminal.id });
			const snapshot = await current.until(() => current.output[0]);
			assert(snapshot.length > 2 * TERMINAL_OUTPUT_WINDOW, `snapshot of ${snapshot.length} bytes`);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			// One snapshot and nothing more: the terminal is idle. Before the fix it resent the snapshot in a loop.
			assert.equal(current.events.filter((event) => event.type === "attached").length, 1);
			assert(
				received() < snapshot.length + 4096,
				`received ${received()} bytes for a ${snapshot.length} byte snapshot`,
			);

			// Live output still reaches it.
			writer.send(new TextEncoder().encode("echo live-$((2+3))\n"));
			await current.until(() => (current.text().includes("live-5") ? true : undefined));
			assert.equal(current.events.filter((event) => event.type === "attached").length, 1);
		} finally {
			for (const timer of timers) clearInterval(timer);
			const last = await client(directory);
			last.send({ type: "shutdown" });
			await new Promise((resolve) => last.socket.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
			viewer?.socket.destroy();
			writer.socket.destroy();
			await rm(directory, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
