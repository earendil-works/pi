// The terminals plugin on the server for its tests (`testPlugin`, beside the things and environments plugins' server
// facets and a stand-in machine whose terminals are fake programs, environments/test/fake-machine.ts): Pi, its
// Terminals and this device's machine, people and agents put in, grants, holds, and the attach socket's handler driven
// through a stand-in socket (`FakeSocket`: the HTTP component, which upgrades a browser's request, is not on this
// tier; the socket end to end is e2e.test.ts's), with stand-in sign-ins (`LinkOpened`, as the sign-in plugin
// contributes it: a request's `x-sign-in` header names its sign-in, `revoke` ends one).

import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	type P3Principal,
	type Reference,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest, LinkOpened, type WebSocketHandle } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { type FakeMachine, fakeMachine, fakeType } from "../../environments/test/fake-machine.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { SOCKET_PATH, Terminals, TerminalsKind } from "../kind.ts";

/** A person's principal. */
export type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
export const BY: Source = { kind: "plugin", plugin: "test" };

/** The size the tests open terminals with. */
export const SIZE = { columns: 80, rows: 24 };

/** The plugin under test and what its tests reach. */
export type TerminalsPlugin = {
	readonly t: TestedPlugin<P3Principal>;
	readonly things: Reference<typeof ThingsStore>;
	readonly pi: string;
	/** Pi's Terminals: made again with a new id when its last link goes (a test then sets it). */
	terminals: string;
	readonly machine: string;
	readonly fake: FakeMachine;
	/** Makes person `name`, put into `workspace` (Pi by default); their principal. */
	person(name: string, workspace?: string): Promise<Person>;
	/** Session `session`'s agent, put into Pi; its worker's principal. */
	agent(session: string): Promise<P3Principal>;
	/** Gives (or withholds, `gives: false`) `party` the ticks `ticks` on `thing` in `where`. */
	grant(where: string, thing: string, party: Party, ticks: string[], gives?: boolean): Promise<unknown>;
	/** Runs `fn` with `principal`'s Terminals held in `where` (Pi by default). */
	holding<T>(
		principal: P3Principal,
		fn: (terminals: Reference<typeof Terminals>, ctx: Ctx<P3Principal>) => Promise<T>,
		where?: string,
	): Promise<T>;
	/**
	 * Terminal `id`'s attach socket as `ctx`'s caller, at the address `r.attach` answers, once its handler set up;
	 * opened by sign-in `signIn` ("s" by default).
	 */
	socket(r: Reference<typeof Terminals>, id: string, ctx: Ctx<P3Principal>, signIn?: string): Promise<FakeSocket>;
	/** Ends sign-in `signIn`: the links and sockets it opened close. */
	revoke(signIn: string): void;
};

/** The terminals plugin with Pi set up; every person in Pi watches (as Who may would: the kind gives them nothing). */
export async function terminalsPlugin(): Promise<TerminalsPlugin> {
	const fake = fakeMachine();
	const signIns = new Map<string, Set<() => void>>();
	const stubs = [
		{
			name: "@earendil-works/p3-sign-in",
			facet: defineFacet((_host, self) =>
				self.contribute(LinkOpened, (request, close) => {
					const id = request.headers.get("x-sign-in");
					if (id === null) return undefined;
					const closes = signIns.get(id) ?? new Set();
					signIns.set(id, closes.add(close));
					return () => closes.delete(close);
				}),
			),
		},
		// Sorts first, so its type wins this device's name over the environments plugin's, whose programs are real.
		{ name: "@earendil-works/p3-a-fake-machine", facet: fakeType(() => fake.host) },
		{ name: "@earendil-works/p3-things", facet: thingsServer },
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	];
	const t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs }, context);
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const grant = (where: string, thing: string, party: Party, ticks: string[], gives = true) =>
		things.setGrants(
			{ source: BY, grants: ticks.map((tick) => ({ workspace: where, thing, party, tick, gives })) },
			context,
		);
	const plugin: TerminalsPlugin = {
		t,
		things,
		pi,
		terminals: await seeded(await t.host.get(OneThing, { kind: TerminalsKind.name }, context), context),
		machine: await seeded(await t.host.get(OneThing, { kind: MACHINE_KIND }, context), context),
		fake,
		person: async (name, workspace = pi) => {
			const id = await things.createPerson({ name, madeBy: BY }, context);
			await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
			return { kind: "person", id, name };
		},
		agent: async (session) => {
			await things.putParty({ workspace: pi, party: { kind: "agent", session }, source: BY }, context);
			return { kind: "worker", session };
		},
		grant,
		holding: (principal, fn, where = pi) =>
			t.root(
				async (ctx) =>
					fn(await ctx.get(Terminals, { workspace: where, thing: plugin.terminals }, { readyTimeout: 500 }), ctx),
				context,
				{ principal },
			),
		socket: async (r, id, ctx, signIn = "s") => {
			const { url } = await r.attach!({ terminal: id }, ctx);
			const socket = attachSocket(t, url, ctx, signIn);
			await socket.ready;
			return socket;
		},
		revoke: (signIn) => {
			for (const close of signIns.get(signIn) ?? []) close();
		},
	};
	await grant(pi, plugin.terminals, { kind: "everyone" }, ["watch"]);
	return plugin;
}

/**
 * The attach socket's handler, as the HTTP component would run it for a request to `url` of sign-in `signIn` (none:
 * a request no sign-in tracks), on a `FakeSocket`.
 */
export function attachSocket(
	t: TestedPlugin<P3Principal>,
	url: string,
	ctx: Ctx<P3Principal>,
	signIn: string | null = "s",
): FakeSocket {
	const entry = t
		.contributions(Http)
		.flatMap(({ value }) => Object.entries(value.sockets ?? {}))
		.find(([pattern]) => pattern === SOCKET_PATH)![1];
	const handler = typeof entry === "function" ? entry : entry.handler;
	const socket = new FakeSocket();
	// The handler and the sign-ins read the request's query and the one header only.
	const request = {
		method: "GET",
		query: new URL(url, "http://p3").searchParams,
		headers: new Headers(signIn === null ? {} : { "x-sign-in": signIn }),
	} as unknown as HttpRequest;
	// The stand-in has the members of `ws`'s WebSocket the handler uses (`on`, `send`, `close`).
	void Promise.resolve(handler(socket as unknown as WebSocketHandle, request, ctx)).catch((error: unknown) =>
		socket.failed(error),
	);
	return socket;
}

/**
 * A browser's end of an attach socket: the output (`next`) and text frames (`told`) the handler sent, its close code
 * (`closed`), and what a page sends (`type`, `tell`).
 */
export class FakeSocket extends EventEmitter {
	/** The text frames sent, parsed, in order. */
	readonly told: unknown[] = [];
	/** The binary frames sent and not read with `next` yet. */
	readonly #output: Uint8Array[] = [];
	#waiting: (() => void) | undefined;
	#code: number | undefined;
	#error: unknown;
	/** Settles with the close code once the handler closed the socket. */
	readonly closed: Promise<number>;

	/** The close code, failing after `ms` without one (a regression fails fast, naming itself). */
	closedWithin(ms = 5_000): Promise<number> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`the socket did not close within ${ms} ms`)), ms);
			void this.closed.then((code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	}
	/** Settles once the handler told the size (it set the socket up), or closed it. */
	readonly ready: Promise<void>;
	#close: (code: number) => void = () => {};
	#ready: () => void = () => {};
	/** Whether frames stay in the socket's buffer (a peer that stopped reading) until `release`. */
	hold = false;
	readonly #held: { readonly size: number; readonly sent: () => void }[] = [];
	/** The bytes in the socket's buffer now, and the most it ever held. */
	#buffered = 0;
	most = 0;

	/** Lets the frames held in the buffer go, `count` of them (all by default): a writer that drains slowly. */
	release(count = Number.POSITIVE_INFINITY): void {
		if (count === Number.POSITIVE_INFINITY) this.hold = false;
		for (const { size, sent } of this.#held.splice(0, count)) {
			this.#buffered -= size;
			sent();
		}
	}

	constructor() {
		super();
		this.closed = new Promise((resolve) => {
			this.#close = resolve;
		});
		this.ready = new Promise((resolve) => {
			this.#ready = resolve;
		});
	}

	/** The handler's send; `sent` runs once the frame left (here: on the next microtask, unless `hold` holds it). */
	send(data: string | Uint8Array, sent?: () => void): void {
		if (sent !== undefined) {
			const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
			this.#buffered += size;
			this.most = Math.max(this.most, this.#buffered);
			if (this.hold) this.#held.push({ size, sent });
			else {
				queueMicrotask(() => {
					this.#buffered -= size;
					sent();
				});
			}
		}
		if (typeof data === "string") {
			const told = JSON.parse(data) as { kind?: string };
			this.told.push(told);
			if (told.kind === "size") this.#ready();
		} else this.#output.push(data);
		this.#wake();
	}

	/** The handler's close. */
	close(code: number): void {
		if (this.#code !== undefined) return;
		this.#code = code;
		this.#close(code);
		this.#ready();
		this.#wake();
	}

	/** The handler failed (the HTTP component would close the socket 1011). */
	failed(error: unknown): void {
		this.#error = error;
		this.close(1011);
	}

	/** The next binary frame as text, waiting for it; "" once the socket closed and every frame was read. */
	async next(): Promise<string> {
		for (;;) {
			const bytes = this.#output.shift();
			if (bytes !== undefined) return Buffer.from(bytes).toString();
			if (this.#error !== undefined) throw this.#error;
			if (this.#code !== undefined) return "";
			await new Promise<void>((resolve) => {
				this.#waiting = resolve;
			});
		}
	}

	/** How many bytes of binary frames came and were not read with `next`. */
	get unread(): number {
		return this.#output.reduce((sum, bytes) => sum + bytes.length, 0);
	}

	/** Takes every binary frame that came: their bytes. */
	take(): number {
		const bytes = this.unread;
		this.#output.length = 0;
		return bytes;
	}

	/** Waits until a frame comes or the socket closes. */
	async frame(): Promise<void> {
		if (this.#output.length > 0 || this.#code !== undefined) return;
		await new Promise<void>((resolve) => {
			this.#waiting = resolve;
		});
	}

	/** What a page types: a binary frame. */
	type(text: string): void {
		this.emit("message", Buffer.from(text), true);
	}

	/** What a page tells: a text frame of `value`. */
	tell(value: unknown): void {
		this.emit("message", Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), false);
	}

	#wake(): void {
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.();
	}
}
