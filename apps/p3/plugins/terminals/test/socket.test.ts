// The attach socket (socket.ts) on the server tier (plugin.ts: its handler on a stand-in socket, the machine's
// programs fakes): it tells the viewer how much kept output comes first and the size, then sends the kept output and
// what follows; one terminal, many viewers, each with its own stream; what a viewer with Use types and its size reach
// the program, a viewer who only watches sends nothing, and a frame that is not one of the page's is ignored; another
// viewer's resize reaches every viewer; a viewer is sent at most `WINDOW` bytes it has not drawn, and one that fell
// behind 10 MiB gets the kept tail; it closes 1000 when the terminal ends, and `SOCKET_REFUSED` for a person not let
// in or in the flush that withholds Watch and Use, the machine, or the workspace (decision 25), a read under way
// included and nothing printed after, and with the sign-in that opened it; a page's claim of what it drew counts only
// what was sent, the socket's buffer holds at most `WINDOW`, and a flood before the check closes it; one viewer that
// may type answers the program's queries.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, until } from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { TERMINAL_BACKLOG } from "../../environments/contract.terminal-host.server.ts";
import { SOCKET_PATH, SOCKET_REFUSED } from "../kind.ts";
import { WINDOW } from "../viewer-socket.ts";
import { attachSocket, SIZE, type TerminalsPlugin, terminalsPlugin } from "./plugin.ts";

let p: TerminalsPlugin;

beforeEach(async () => {
	p = await terminalsPlugin();
});

afterEach(() => p.t.close(context));

/** The stand-in machine's programs, in the order they started. */
const started = () => p.fake.started;

/** Opens a terminal as session s1's agent (which has Use by default); its id. */
async function opened(): Promise<string> {
	const worker = await p.agent("s1");
	return p.holding(worker, (w, ctx) => w.open!({ machine: p.machine, folder: "/tmp", ...SIZE }, ctx));
}

describe("a viewer's stream", () => {
	it("tells the kept output's size and the terminal's size first, then sends the kept output and what follows", async () => {
		const id = await opened();
		started()[0]!.say("kept");
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			assert.equal(await socket.next(), "kept");
			assert.deepEqual(socket.told, [
				{ kind: "kept", end: 4 },
				{ kind: "size", ...SIZE },
				{ kind: "from", offset: 0 },
			]);
			started()[0]!.say("live");
			assert.equal(await socket.next(), "live");
		});
	});

	it("gives each viewer their own stream: one viewer leaving leaves the other's running (1174 test 2)", async () => {
		const id = await opened();
		const [ann, kim] = [await p.person("Ann"), await p.person("Kim")];
		await p.holding(ann, async (a, ctx) => {
			const anns = await p.socket(a, id, ctx);
			await p.holding(kim, async (k, kctx) => {
				const kims = await p.socket(k, id, kctx);
				started()[0]!.say("one");
				assert.equal(await kims.next(), "one");
			});
			assert.equal(await anns.next(), "one");
			started()[0]!.say("two");
			assert.equal(await anns.next(), "two");
		});
		assert.equal(started()[0]!.closed, false);
	});

	it("closes 1000 once the terminal ended and its output was sent", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			started()[0]!.say("bye");
			started()[0]!.exit(0);
			assert.equal(await socket.next(), "bye");
			assert.equal(await socket.closed, 1000);
		});
	});
});

describe("what a viewer sends", () => {
	it("types and resizes with Use; another viewer follows the size; a viewer who watches sends nothing", async () => {
		const id = await opened();
		const [ann, kim] = [await p.person("Ann"), await p.person("Kim")];
		await p.grant(p.pi, p.terminals, { kind: "person", person: ann.id }, ["use"]);
		await p.holding(ann, async (a, ctx) => {
			const anns = await p.socket(a, id, ctx);
			await p.holding(kim, async (k, kctx) => {
				const kims = await p.socket(k, id, kctx);
				await until(k.terminals!, (list) => list.length === 1, within("Kim's list", kctx));
				kims.type("from kim");
				kims.tell({ kind: "resize", columns: 50, rows: 10 });
				anns.type("ls\r");
				anns.tell({ kind: "resize", columns: 100, rows: 30 });
				assert.deepEqual(started()[0]!.typed, ["ls\r"]);
				assert.deepEqual(started()[0]!.size, [100, 30]);
				assert.deepEqual(kims.told.at(-1), { kind: "size", columns: 100, rows: 30 });
			});
		});
	});

	it("keeps what is typed while the socket is still checked, in order", async () => {
		const id = await opened();
		await p.holding(await p.agent("s1"), async (w, ctx) => {
			const { url } = await w.attach!({ terminal: id }, ctx);
			const socket = attachSocket(p.t, url, ctx);
			socket.type("e");
			socket.type("cho");
			await socket.ready;
			assert.deepEqual(started()[0]!.typed, ["e", "cho"]);
		});
	});

	it("ignores a text frame that is not one of the page's (a trust boundary)", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.grant(p.pi, p.terminals, { kind: "person", person: ann.id }, ["use"]);
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			for (const frame of ["{", "null", "[]", { kind: "resize", columns: 0, rows: 5 }, { kind: "resize" }]) {
				socket.tell(frame);
			}
			socket.tell({ kind: "resize", columns: 5000, rows: 5 });
			socket.tell({ kind: "drawn", bytes: -1 });
			assert.deepEqual(started()[0]!.size, [SIZE.columns, SIZE.rows]);
			started()[0]!.say("on");
			assert.equal(await socket.next(), "on");
		});
	});
});

describe("flow", () => {
	it("sends at most WINDOW bytes the viewer did not draw; one that fell behind 10 MiB gets the kept tail (1174 test 8)", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			const piece = new Uint8Array(48 * 1024).fill(66);
			let received = 0;
			// Piece by piece while the window has room: then exactly the window, the last piece cut.
			while (received < WINDOW) {
				started()[0]!.options.onData(piece);
				await socket.frame();
				received += socket.take();
			}
			assert.equal(received, WINDOW);
			for (let sent = 0; sent < 10 * 1024 * 1024; sent += piece.length) started()[0]!.options.onData(piece);
			// A stream's wake and its send run in microtasks, all done before the next macrotask: with a full window it
			// sent nothing of the 10 MiB.
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(socket.unread, 0);
			// Drawn: it goes on from the oldest byte kept, never the 10 MiB.
			socket.tell({ kind: "drawn", bytes: received });
			let after = 0;
			while (after < TERMINAL_BACKLOG) {
				await socket.frame();
				const taken = socket.take();
				after += taken;
				socket.tell({ kind: "drawn", bytes: taken });
			}
			assert.equal(after, TERMINAL_BACKLOG);
		});
	});

	// Opus, round 1, S1: one `drawn` of a terabyte, then a page that reads no more.
	it("counts as drawn only what was sent: a page that claims more gets no more ahead", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			socket.tell({ kind: "drawn", bytes: 1024 ** 4 });
			const piece = new Uint8Array(64 * 1024).fill(67);
			for (let sent = 0; sent < 10 * 1024 * 1024; sent += piece.length) {
				started()[0]!.options.onData(piece);
				await new Promise((resolve) => setImmediate(resolve));
			}
			assert.ok(socket.unread <= WINDOW, `${socket.unread} bytes sent to a page that drew none`);
		});
	});

	it("keeps at most WINDOW in the socket's buffer for a page that stopped reading, whatever it says it drew", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			socket.hold = true;
			const piece = new Uint8Array(64 * 1024).fill(68);
			for (let sent = 0; sent < 4 * 1024 * 1024; sent += piece.length) {
				started()[0]!.options.onData(piece);
				await new Promise((resolve) => setImmediate(resolve));
				socket.tell({ kind: "drawn", bytes: socket.unread });
			}
			assert.ok(socket.most <= WINDOW, `${socket.most} bytes in the buffer`);
			socket.take();
			socket.release();
			await socket.frame();
			assert.ok(socket.unread > 0, "it goes on once the buffer emptied");
		});
	});

	// Astra, round 2, S2: uneven pieces and a writer that drains one frame at a time; sizes while the buffer is full.
	it("keeps output and text frames within WINDOW in a slow writer's buffer, and only the newest size waiting", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.grant(p.pi, p.terminals, { kind: "person", person: ann.id }, ["use"]);
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			socket.hold = true;
			// The same uneven pieces every run.
			let seed = 7;
			const next = () => {
				seed = (seed * 1103515245 + 12345) % 2 ** 31;
				return seed;
			};
			for (let round = 0; round < 200; round++) {
				started()[0]!.options.onData(new Uint8Array(1 + (next() % 100_000)).fill(69));
				socket.tell({ kind: "resize", columns: 50 + round, rows: 20 });
				await new Promise((resolve) => setImmediate(resolve));
				socket.release(1);
				socket.tell({ kind: "drawn", bytes: socket.take() });
			}
			assert.ok(socket.most <= WINDOW, `${socket.most} bytes in the buffer`);
			const sizes = () => socket.told.filter((told) => (told as { kind: string }).kind === "size").length;
			const told = sizes();
			socket.release();
			await eventually(
				() => socket.told.at(-1),
				(last) => JSON.stringify(last) === JSON.stringify({ kind: "size", columns: 249, rows: 20 }),
			);
			assert.ok(sizes() - told <= 1, "the sizes that waited went as one");
		});
	});

	it("closes a socket whose page sends more than it may before the socket was checked, in bytes or frames", async () => {
		const id = await opened();
		await p.holding(await p.agent("s1"), async (w, ctx) => {
			const { url } = await w.attach!({ terminal: id }, ctx);
			const big = attachSocket(p.t, url, ctx);
			for (let piece = 0; piece < 3; piece++) big.type("x".repeat(32 * 1024));
			const many = attachSocket(p.t, url, ctx);
			for (let piece = 0; piece < 300; piece++) many.type("");
			for (const socket of [big, many]) {
				assert.equal(await socket.closedWithin(), SOCKET_REFUSED);
			}
			assert.deepEqual(started()[0]!.typed, []);
		});
	});
});

describe("who answers a program's queries", () => {
	// Opus and Astra, round 1, S2: two viewers with Use each typed the answer to one query.
	it("is one viewer that may type: the first, then the one that typed last, then the next when it goes", async () => {
		const id = await opened();
		const [ann, kim, sam] = [await p.person("Ann"), await p.person("Kim"), await p.person("Sam")];
		for (const person of [ann, kim]) await p.grant(p.pi, p.terminals, { kind: "person", person: person.id }, ["use"]);
		const answers = (socket: { told: unknown[] }) =>
			socket.told
				.filter((told) => (told as { kind: string }).kind === "answer")
				.map((told) => (told as { yes: boolean }).yes);
		await p.holding(ann, async (a, actx) => {
			const anns = await p.socket(a, id, actx);
			await p.holding(sam, async (s, sctx) => {
				const sams = await p.socket(s, id, sctx);
				await p.holding(kim, async (k, kctx) => {
					const kims = await p.socket(k, id, kctx);
					assert.deepEqual([answers(anns), answers(kims), answers(sams)], [[true], [], []]);
					kims.type("x");
					assert.deepEqual([answers(anns), answers(kims)], [[true, false], [true]]);
					// A page's answer is written like typing but moves no election (Astra, round 2, S1).
					anns.tell({ kind: "reply", text: "\u001b[?62c" });
					assert.deepEqual(started()[0]!.typed, ["x", "\u001b[?62c"]);
					assert.deepEqual([answers(anns), answers(kims)], [[true, false], [true]]);
					// Each change names the output byte it starts at.
					assert.ok(kims.told.some((told) => (told as { kind: string; at?: number }).at !== undefined));
				});
				assert.deepEqual(answers(sams), [], "a viewer who only watches never answers");
				// Kim's socket ends with her hold, then the next viewer that may type answers.
				await eventually(
					() => answers(anns),
					(told) => told.length === 3,
				);
				assert.deepEqual(answers(anns), [true, false, true], "Kim gone: Ann answers again");
			});
		});
	});
});

describe("a socket holds what lets its viewer in (decision 25)", () => {
	// Astra, round 1, M3: revoking a sign-in left its terminal socket open.
	// Astra, round 2, M2: a revoke only started the close handshake; the handler kept taking frames until it ended.
	it("ends at once with its sign-in: nothing typed or sent after, also while the socket is still checked", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.grant(p.pi, p.terminals, { kind: "person", person: ann.id }, ["use"]);
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx, "late");
			p.revoke("late");
			// The close was only asked for: ws would still deliver frames until the peer answers it.
			socket.type("typed after");
			socket.tell({ kind: "resize", columns: 40, rows: 10 });
			started()[0]!.say("printed after");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual([started()[0]!.typed, started()[0]!.size, socket.unread], [[], [SIZE.columns, SIZE.rows], 0]);
			const { url } = await a.attach!({ terminal: id }, ctx);
			const early = attachSocket(p.t, url, ctx, "early");
			early.type("typed early");
			p.revoke("early");
			assert.equal(await early.closedWithin(), SOCKET_REFUSED);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual([started()[0]!.typed, early.told], [[], []]);
		});
	});

	it("closes with the sign-in that opened it; another sign-in's socket stays; none, refused", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const phone = await p.socket(a, id, ctx, "phone");
			const desk = await p.socket(a, id, ctx, "desk");
			p.revoke("phone");
			assert.equal(await phone.closedWithin(), SOCKET_REFUSED);
			started()[0]!.say("still");
			assert.equal(await desk.next(), "still");
			const { url } = await a.attach!({ terminal: id }, ctx);
			assert.equal(await attachSocket(p.t, url, ctx, null).closedWithin(), SOCKET_REFUSED);
		});
	});

	it("is refused to a person not let in, and for a query that names nothing", async () => {
		const id = await opened();
		const url = `${SOCKET_PATH}?${new URLSearchParams({ workspace: p.pi, thing: p.terminals, terminal: id })}`;
		const stranger = { kind: "person", id: "nobody", name: "Nobody" } as const;
		await p.t.root(async (ctx) => assert.equal(await attachSocket(p.t, url, ctx).closed, SOCKET_REFUSED), context, {
			principal: stranger,
		});
		const ann = await p.person("Ann");
		await p.holding(ann, async (_a, ctx) => {
			assert.equal(await attachSocket(p.t, SOCKET_PATH, ctx).closed, SOCKET_REFUSED);
			const other = `${SOCKET_PATH}?${new URLSearchParams({ workspace: p.pi, thing: p.terminals, terminal: "x" })}`;
			assert.equal(await attachSocket(p.t, other, ctx).closed, SOCKET_REFUSED);
		});
	});

	it("closes in the flush in which Watch is withheld, a read under way included (1174 test 3)", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			const waiting = socket.next();
			await p.grant(p.pi, p.terminals, { kind: "person", person: ann.id }, ["watch"], false);
			assert.equal(await waiting, "", "the stream ended");
			assert.equal(await socket.closed, SOCKET_REFUSED);
		});
	});

	it("closes when the machine is withheld from the person, with nothing printed after (opus round 2, M1)", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			started()[0]!.say("before ");
			assert.equal(await socket.next(), "before ");
			await p.grant(p.pi, p.machine, { kind: "person", person: ann.id }, ["@open"], false);
			await until(a.terminals!, (rows) => rows.length === 0, within("the list without it", ctx));
			started()[0]!.say("secret");
			assert.equal(await socket.next(), "", "the stream ended");
			assert.equal(await socket.closed, SOCKET_REFUSED);
		});
	});

	it("closes when the person leaves the workspace; the terminal runs on", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const socket = await p.socket(a, id, ctx);
			const waiting = socket.next();
			await p.things.removeParty({ workspace: p.pi, party: { kind: "person", person: ann.id } }, context);
			assert.equal(await waiting, "");
			started()[0]!.say("after");
			assert.equal(await socket.next(), "");
		});
		assert.equal(started()[0]!.closed, false);
	});

	it("does not start when the terminal is not in the person's list (astra round 2)", async () => {
		const id = await opened();
		const ann = await p.person("Ann");
		await p.holding(ann, async (a, ctx) => {
			const { url } = await a.attach!({ terminal: id }, ctx);
			await p.grant(p.pi, p.machine, { kind: "person", person: ann.id }, ["@open"], false);
			await until(a.terminals!, (rows) => rows.length === 0, within("the list", ctx));
			assert.equal(await attachSocket(p.t, url, ctx).closed, SOCKET_REFUSED);
		});
	});
});
