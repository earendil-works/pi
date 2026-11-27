// Terminals on this device (ERNDL-1174, decision 133): a keystroke's echo as a browser sees it, through p3's real
// server (`testServer`), the attach socket (a binary WebSocket per viewer, the owner's cookie) and the shell in
// pi-env's daemon: idle, and while a second terminal streams `yes` to a viewer of its own that reads as fast as it can;
// then 10 MiB of output to one viewer. Medians and p99 of `KEYS` keys, `GAP_MS` apart, the first `WARM` apart. The
// bench of round 2 (/home/badlogic/p3-bench-workspaces/RESULTS-env-latency.md) is the comparison: p2 0.13 ms idle,
// p3 with the old HTTP stream and `type` calls 0.26 ms. Run from apps/p3 with Node 26:
// node --conditions=source --disable-warning=ExperimentalWarning bench/terminals.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, type Reference } from "@earendil-works/p3/v1";
import { OneThing } from "@earendil-works/p3/v1/server";
import { testServer } from "@earendil-works/p3/v1/testing";
import { WebSocket } from "ws";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { Terminals, TerminalsKind } from "../plugins/terminals/kind.ts";
import { piOf } from "../test/support.ts";

/** How many keys are timed in each round. */
const KEYS = 400;

/** How many keys go first, untimed. */
const WARM = 20;

/** The pause between two keys. */
const GAP_MS = 2;

const t = await testServer({}, context);
const folder = await mkdtemp(join(tmpdir(), "p3-bench-terminals-"));
try {
	const owner = await t.client(context);
	const pi = await piOf(owner, context);
	const [thing, machine] = await t.host.root(
		async (ctx) => [
			await seeded(await ctx.get(OneThing, { kind: TerminalsKind.name }), ctx),
			await seeded(await ctx.get(OneThing, { kind: MACHINE_KIND }), ctx),
		],
		context,
	);
	const terminals = await owner.get(Terminals, { workspace: pi, thing }, context);
	const cookie = await t.cookie(context);
	const typing = await viewer(terminals, machine, cookie, t.port);
	// A quiet line: `cat` echoes what is typed and nothing else (the terminal's echo, no prompt to redraw).
	typing.send("stty -icanon; cat > /dev/null\r");
	await typing.until(/cat > \/dev\/null\r\n/);
	console.log("idle", summary(await keystrokes(typing)));
	const streaming = await viewer(terminals, machine, cookie, t.port);
	streaming.send("yes 0123456789abcdefghijklmnopqrstuvwxyz\r");
	await streaming.until(/0123456789/);
	console.log("while another streams", summary(await keystrokes(typing)));
	streaming.send("\u0003");
	const ten = await viewer(terminals, machine, cookie, t.port);
	ten.send("stty -echo; echo READY-$((1+1))\r");
	await ten.until(/READY-2/);
	const began = performance.now();
	const before = ten.received();
	ten.send("head -c 10485760 /dev/zero | tr '\\0' x; echo END-$((1+1))\r");
	await ten.until(/END-2/);
	// What reached the viewer, not what the program printed: a viewer that falls behind skips to the oldest byte kept.
	const got = (ten.received() - before) / 1024 / 1024;
	const seconds = (performance.now() - began) / 1000;
	console.log(
		`10 MiB printed to one viewer: ${got.toFixed(2)} MiB received (${(100 - got * 10).toFixed(1)} % skipped) in ${seconds.toFixed(2)} s, ${(got / seconds).toFixed(0)} MiB/s received`,
	);
	await owner.close(context);
} finally {
	await t.close(context);
	await rm(folder, { recursive: true, force: true });
}

/** A new terminal on this device and a browser's attach socket to it, drawing (acknowledging) all it gets. */
async function viewer(terminals: Reference<typeof Terminals>, machine: string, cookie: string, port: number) {
	const id = await terminals.open!({ machine, folder, columns: 120, rows: 40 }, context);
	const { url } = await terminals.attach!({ terminal: id }, context);
	const socket = new WebSocket(`ws://127.0.0.1:${port}${url}`, {
		headers: { cookie, origin: `http://127.0.0.1:${port}` },
	});
	await new Promise((resolve) => socket.once("open", resolve));
	let tail = "";
	let received = 0;
	let heard: (() => void) | undefined;
	socket.on("message", (data, binary) => {
		if (!binary) return;
		// ws's default binary type: a Buffer per message.
		const bytes = data as Buffer;
		received += bytes.length;
		socket.send(JSON.stringify({ kind: "drawn", bytes: bytes.length }));
		tail = (tail + bytes.toString("latin1")).slice(-4096);
		heard?.();
	});
	return {
		received: () => received,
		send: (text: string) => socket.send(Buffer.from(text)),
		/** Resolves at the next output. */
		next: () =>
			new Promise<void>((resolve) => {
				heard = resolve;
			}),
		/** Waits until the output's tail matches `pattern`. */
		until: async (pattern: RegExp) => {
			while (!pattern.test(tail)) {
				await new Promise<void>((resolve) => {
					heard = resolve;
				});
			}
		},
	};
}

/** The times from typing a key to its echo, in milliseconds. */
async function keystrokes(on: Awaited<ReturnType<typeof viewer>>): Promise<number[]> {
	const times: number[] = [];
	for (let key = 0; key < WARM + KEYS; key++) {
		const echo = on.next();
		const sent = performance.now();
		on.send("a");
		await echo;
		if (key >= WARM) times.push(performance.now() - sent);
		await new Promise((resolve) => setTimeout(resolve, GAP_MS));
	}
	return times;
}

/** Median, p95 and p99 of `times`. */
function summary(times: number[]): string {
	const sorted = times.toSorted((a, b) => a - b);
	const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!.toFixed(2);
	return `median ${at(0.5)} ms, p95 ${at(0.95)} ms, p99 ${at(0.99)} ms (n ${times.length})`;
}
