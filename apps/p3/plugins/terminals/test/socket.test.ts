// The attach socket (socket.ts) on the server tier (plugin.ts: its handler on a stand-in socket, the machine's
// programs fakes): it tells the viewer how much kept output comes first and the size, then sends the kept output and
// what follows; one terminal, many viewers, each with its own stream; what a viewer with Use types and its size reach
// the program, a viewer who only watches sends nothing, and a frame that is not one of the page's is ignored; another
// viewer's resize reaches every viewer; a viewer is sent at most `WINDOW` bytes it has not drawn, and one that fell
// behind 10 MiB gets the kept tail; it closes 1000 when the terminal ends, and `SOCKET_REFUSED` for a person not let
// in or in the flush that withholds Watch and Use, the machine, or the workspace (decision 25), a read under way
// included and nothing printed after.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { TERMINAL_BACKLOG, TERMINAL_FRAME } from "../../environments/contract.terminal-host.server.ts";
import { SOCKET_PATH, SOCKET_REFUSED } from "../kind.ts";
import { WINDOW } from "../socket.ts";
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
				{ kind: "kept", bytes: 4 },
				{ kind: "size", ...SIZE },
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
			const piece = new Uint8Array(64 * 1024).fill(66);
			let received = 0;
			// Piece by piece, each sent while the window allows: then one past it.
			while (received <= WINDOW) {
				started()[0]!.options.onData(piece);
				await socket.frame();
				received += socket.take();
			}
			assert.ok(received <= WINDOW + TERMINAL_FRAME, `${received} bytes before anything was drawn`);
			for (let sent = 0; sent < 10 * 1024 * 1024; sent += piece.length) started()[0]!.options.onData(piece);
			// A stream's wake and its send run in microtasks, all done before the next macrotask: past its window it
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
});

describe("a socket holds what lets its viewer in (decision 25)", () => {
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
