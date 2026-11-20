// Tests of a client host with its plugins (slice 11 §2, §4, decisions "Slice 11, P4" to "P6", p3 step 0a), over an
// in-memory link to a server serving the scripts object: the initial scripts loaded with the core facets, a new set
// applied in place (only changed scripts fetched; a failed one keeps its old facet and is tried again by the next set
// that has it), the stylesheets loaded before the reload and settled after it, a new base or an outdated server ending
// the client.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import * as chordNext from "../../src/index.ts";
import {
	type ClientStyles,
	constant,
	createHost,
	defineFacet,
	hostKind,
	local,
	memoryLinkPair,
	type RegisteredScript,
	type ScriptSet,
	type SocketEvents,
	startClient,
	str,
	WebScripts,
} from "../../src/index.ts";
import { publishTo, scriptsFacet } from "../../src/node/surfaces/current.ts";

type TestPrincipal = { readonly kind: "server" } | { readonly kind: "user"; readonly id: string };

const Greeting = local("test.greeting", { version: 1, params: {}, members: { text: str() } });

/**
 * A registered script of plugin `plugin` (digest `digest`) serving `Greeting` with `text`; `broken` throws instead,
 * and its first `failing` runs throw too.
 */
function script(plugin: string, digest: string, text: string, failing = 0): RegisteredScript {
	let fails = failing;
	return {
		plugin,
		digest,
		run: (require, module) => {
			if (text === "broken" || fails-- > 0) throw new Error("broken plugin");
			const chord = require("@test/chord") as typeof chordNext;
			const facet = chord.defineFacet((host) => host.serve(Greeting, () => ({ text: chord.constant(text) })));
			Object.assign(module, { exports: { default: facet } });
		},
	};
}

/** The set of `scripts` under base `base`, each with a stylesheet named after its digest. */
function setOf(base: string, scripts: readonly RegisteredScript[]): ScriptSet {
	return {
		base,
		combined: "/combined.js",
		plugins: scripts.map(({ plugin, digest }) => ({
			name: plugin,
			digest,
			url: `/${plugin}.${digest}.js`,
			css: `/${plugin}.${digest}.css`,
		})),
	};
}

/** A timer of the client's environment the test fires itself: its pause and its callback. */
type ManualTimer = { readonly ms: number; readonly fire: () => void };

/**
 * A server serving `WebScripts` with `initial`, and a client started against it with `scripts` available to fetch;
 * `failing` fetches fail first (a network error), `manual` collects the environment's timers instead of running them.
 */
async function setup(
	initial: readonly RegisteredScript[],
	available: readonly RegisteredScript[] = [],
	more: {
		readonly failing?: number;
		readonly manual?: ManualTimer[];
		readonly styles?: ClientStyles;
		readonly follow?: false;
		/** The server never answers: the client's sockets never open. */
		readonly offline?: true;
		/** The set the server shows from the start (default: `initial`'s). */
		readonly shown?: readonly RegisteredScript[];
		/** Holds the server's base answers until it settles (a slow network). */
		readonly baseAnswers?: Promise<void>;
		readonly limits?: chordNext.PartLimits;
	} = {},
) {
	let failing = more.failing ?? 0;
	const server = createHost<TestPrincipal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		onError: () => {},
	});
	await server.load(
		[{ name: "chord.web", facet: scriptsFacet<TestPrincipal>("web", { set: setOf("B1", more.shown ?? initial) }) }],
		context,
	);
	const fetched: string[] = [];
	const errors: chordNext.ClientError[] = [];
	const outdated: string[] = [];
	const sockets: { events: SocketEvents; link: chordNext.Link }[] = [];
	let serverBase = "B1";
	const asked: string[] = [];
	const states: chordNext.ConnectionState[] = [];
	const client = await startClient<TestPrincipal>({
		scripts: WebScripts,
		base: "B1",
		initial,
		modules: { "@test/chord": chordNext },
		core: [
			{ name: "@test/core", facet: defineFacet((host) => host.serve(Echo, () => ({ text: constant("core") }))) },
		],
		open: (events) => {
			const [mine, theirs] = memoryLinkPair();
			sockets.push({ events, link: mine });
			if (more.offline === true) return mine;
			server.accept(theirs, { principal: { kind: "user", id: "u" } }, context);
			queueMicrotask(() => events.opened());
			return mine;
		},
		fetchScript: async (entry) => {
			fetched.push(entry.url);
			if (failing > 0) {
				failing--;
				throw new Error(`${entry.url}: network error`);
			}
			const found = available.find(({ plugin, digest }) => plugin === entry.name && digest === entry.digest);
			if (found === undefined) throw new Error(`no ${entry.url}`);
			return found;
		},
		serverBase: async () => {
			asked.push(serverBase);
			await more.baseAnswers;
			return serverBase;
		},
		// With the connection state then: the loop has stopped (`waiting`) before the app starts over.
		outdated: () => outdated.push(`outdated (${states.at(-1)})`),
		onConnection: (state) => states.push(state),
		...(more.styles === undefined ? {} : { styles: more.styles }),
		...(more.follow === undefined ? {} : { follow: more.follow }),
		...(more.limits === undefined ? {} : { limits: more.limits }),
		environment: {
			now: () => Date.now(),
			after: (ms, callback) => {
				if (more.manual !== undefined) {
					const timer = { ms, fire: callback };
					more.manual.push(timer);
					return () => {
						const at = more.manual?.indexOf(timer) ?? -1;
						if (at >= 0) more.manual?.splice(at, 1);
					};
				}
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
			online: () => true,
			onWake: () => () => {},
		},
		onError: (error) => errors.push(error),
	});
	return {
		server,
		client,
		fetched,
		errors,
		outdated,
		sockets,
		asked,
		setServerBase: (base: string) => {
			serverBase = base;
		},
	};
}

const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("loading", () => {
	it("loads the initial scripts with the core facets", async () => {
		const { client, fetched, server } = await setup([script("@test/a", "d1", "hello")]);
		expect((await client.host.get(Greeting, {}, context)).text.value).toBe("hello");
		expect((await client.host.get(Echo, {}, context)).text.value).toBe("core");
		expect(fetched).toEqual([]);
		await client.stop(context);
		await server.close(context);
	});
});

describe("starting offline", () => {
	it("starts with its initial scripts while the server does not answer", async () => {
		const { client, server, sockets } = await setup([script("notes", "d1", "one")], [], { offline: true });
		expect(sockets.length).toBeGreaterThan(0);
		const greeting = await client.host.get(Greeting, {}, context);
		expect(greeting.text.value).toBe("one");
		greeting.release();
		await client.stop(context);
		await server.close(context);
	});
});

describe("applying a new set in place", () => {
	it("applies the set the server shows when it starts following, though no frame brought it", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const { client, fetched, server } = await setup([a1], [a2], { shown: [a2] });
		const greeting = await client.host.get(Greeting, {}, context);
		await until(() => greeting.text.value === "hello again");
		expect(fetched).toEqual(["/@test/a.d2.js"]);
		await client.stop(context);
		await server.close(context);
	});

	it("fetches only changed scripts, reloads the host, keeps an unchanged plugin's facet", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const { client, fetched, server } = await setup([a1], [a2]);
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [a2]), context);
		await until(() => greeting.text.value === "hello again");
		expect(fetched).toEqual(["/@test/a.d2.js"]);
		await client.stop(context);
		await server.close(context);
	});

	it("keeps a plugin's old facet when its new script fails, and reports it", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const broken = script("@test/a", "d2", "broken");
		const { client, server, errors } = await setup([a1], [broken]);
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [broken]), context);
		await until(() => errors.length > 0);
		expect(errors[0]).toMatchObject({ kind: "plugins", failed: [{ plugin: "@test/a" }] });
		expect(greeting.text.value).toBe("hello");
		await client.stop(context);
		await server.close(context);
	});
});

describe("the script each plugin runs (p3 step 0a)", () => {
	it("tries a failed plugin's script again when a reconnect's snapshot has it, not taken as applied", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const flaky = script("@test/a", "d2", "hello again", 1);
		const { client, server, errors, fetched, sockets } = await setup([a1], [flaky]);
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [flaky]), context);
		await until(() => errors.some(({ kind }) => kind === "plugins"));
		expect(greeting.text.value).toBe("hello");
		sockets[0]!.link.close();
		await until(() => greeting.text.value === "hello again");
		expect(fetched).toEqual(["/@test/a.d2.js", "/@test/a.d2.js"]);
		await client.stop(context);
		await server.close(context);
	});
});

describe("stylesheets around an update (p3 step 0a)", () => {
	/** A `ClientStyles` writing what it is asked into `calls`, its loads finishing when the test says. */
	function recording() {
		const calls: string[] = [];
		let loaded = (): void => {};
		const styles: ClientStyles = {
			prepare: async (set) => {
				calls.push(`prepare ${set.plugins.map(({ css }) => css).join(" ")}`);
				await new Promise<void>((resolve) => {
					loaded = resolve;
				});
			},
			settle: (set, kept) => calls.push(`settle ${set.plugins.length} kept [${[...kept].join(" ")}]`),
		};
		return { calls, styles, load: () => loaded() };
	}

	it("loads the new stylesheets before the reload, then settles them with the plugins that kept their old code", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const broken = script("@test/b", "e2", "broken");
		const { calls, styles, load } = recording();
		const { client, server } = await setup([a1, script("@test/b", "e1", "b")], [a2, broken], { styles });
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [a2, broken]), context);
		await until(() => calls.length === 1);
		// The new code waits for its stylesheets.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(greeting.text.value).toBe("hello");
		load();
		await until(() => calls.length === 2);
		expect(calls).toEqual(["prepare /@test/a.d2.css /@test/b.e2.css", "settle 2 kept [@test/b]"]);
		await client.stop(context);
		await server.close(context);
	});

	it("ends the wait for stylesheets at the client's stop: the update stops there", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const calls: string[] = [];
		const styles: ClientStyles = {
			prepare: (set, signal) =>
				new Promise<void>((resolve) => {
					calls.push(`prepare ${set.plugins.length}`);
					signal.addEventListener("abort", () => resolve());
				}),
			settle: () => calls.push("settle"),
		};
		const { client, server } = await setup([a1], [a2], { styles });
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [a2]), context);
		await until(() => calls.length === 1);
		expect(greeting.text.value).toBe("hello");
		await client.stop(context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(calls).toEqual(["prepare 1"]);
		await server.close(context);
	});
});

describe("a failed update (audit F7)", () => {
	it("tries a set whose script did not load again after 1 s, then 2 s, until it applies", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const timers: ManualTimer[] = [];
		const { client, server, errors, fetched } = await setup([a1], [a2], { failing: 2, manual: timers });
		const greeting = await client.host.get(Greeting, {}, context);
		const retries = () => timers.filter(({ ms }) => ms === 1000 || ms === 2000);
		await publishTo(server, "web", setOf("B1", [a2]), context);
		await until(() => retries().length === 1);
		expect(errors.map(({ kind }) => kind)).toEqual(["update_failed"]);
		expect(retries()[0]!.ms).toBe(1000);
		retries()[0]!.fire();
		await until(() => retries().some(({ ms }) => ms === 2000));
		expect(errors.map(({ kind }) => kind)).toEqual(["update_failed", "update_failed"]);
		retries()
			.find(({ ms }) => ms === 2000)!
			.fire();
		await until(() => greeting.text.value === "hello again");
		expect(fetched).toEqual(["/@test/a.d2.js", "/@test/a.d2.js", "/@test/a.d2.js"]);
		await client.stop(context);
		await server.close(context);
	});

	it("drops the retry of a set a newer one replaced, and applies the newer one", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const a3 = script("@test/a", "d3", "hello at last");
		const timers: ManualTimer[] = [];
		const { client, server, fetched } = await setup([a1], [a2, a3], { failing: 1, manual: timers });
		const greeting = await client.host.get(Greeting, {}, context);
		await publishTo(server, "web", setOf("B1", [a2]), context);
		await until(() => timers.some(({ ms }) => ms === 1000));
		await publishTo(server, "web", setOf("B1", [a3]), context);
		await until(() => greeting.text.value === "hello at last");
		// The retry was cancelled with the newer set: nothing is left to fire.
		expect(timers.some(({ ms }) => ms === 1000)).toBe(false);
		expect(fetched).toEqual(["/@test/a.d2.js", "/@test/a.d3.js"]);
		await client.stop(context);
		await server.close(context);
	});
});

describe("outdated clients", () => {
	it("calls outdated for a set with another base", async () => {
		const { client, server, outdated } = await setup([]);
		await publishTo(server, "web", setOf("B2", []), context);
		await until(() => outdated.length === 1);
		await client.stop(context);
		await server.close(context);
	});

	it("asks the server's base at a reconnect: another one stops the loop, then calls outdated", async () => {
		const { client, server, outdated, sockets, setServerBase } = await setup([]);
		setServerBase("B2");
		sockets[0]!.link.close();
		await until(() => outdated.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect([sockets.length <= 2, outdated]).toEqual([true, ["outdated (waiting)"]]);
		await client.stop(context);
		await server.close(context);
	});

	it("a slow base answer after the next link opened: that link ends before outdated is called", async () => {
		const gate = Promise.withResolvers<void>();
		const { client, server, outdated, sockets, setServerBase } = await setup([], [], { baseAnswers: gate.promise });
		setServerBase("B2");
		sockets[0]!.link.close();
		await until(() => sockets.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		gate.resolve();
		await until(() => outdated.length === 1);
		expect(outdated).toEqual(["outdated (waiting)"]);
		await client.stop(context);
		await server.close(context);
	});
});

describe("part limits", () => {
	it("takes parts from the server within the limits it was given, and none past them", async () => {
		const a1 = script("@test/a", "d1", "hello");
		const a2 = script("@test/a", "d2", "hello again");
		const within = await setup([a1], [a2], { shown: [a2], limits: { part: 1024 * 1024 } });
		const greeting = await within.client.host.get(Greeting, {}, context);
		await until(() => greeting.text.value === "hello again");
		await within.client.stop(context);
		await within.server.close(context);
		// The scripts object's set is past 32 bytes: the client never gets it, so it keeps the code it started with.
		const past = await setup([a1], [a2], { shown: [a2], limits: { part: 32 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(past.fetched).toEqual([]);
		expect((await past.client.host.get(Greeting, {}, context)).text.value).toBe("hello");
		await past.client.stop(context);
		await past.server.close(context);
	});
});

describe("a static client (follow: false)", () => {
	it("applies no new set and is never outdated by one", async () => {
		const one = script("notes", "d1", "one");
		const { client, server, fetched, outdated } = await setup([one], [script("notes", "d2", "two")], {
			follow: false,
		});
		await publishTo(server, "web", setOf("B1", [script("notes", "d2", "two")]), context);
		await publishTo(server, "web", setOf("B2", []), context);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect([fetched, outdated]).toEqual([[], []]);
		const greeting = await client.host.get(Greeting, {}, context);
		expect(greeting.text.value).toBe("one");
		greeting.release();
		await client.stop(context);
		await server.close(context);
	});

	it("reconnects without asking the server's base", async () => {
		const { client, server, outdated, sockets, asked, setServerBase } = await setup([], [], { follow: false });
		setServerBase("B2");
		sockets[0]!.link.close();
		await until(() => sockets.length === 2);
		expect([asked, outdated]).toEqual([[], []]);
		await client.stop(context);
		await server.close(context);
	});
});
