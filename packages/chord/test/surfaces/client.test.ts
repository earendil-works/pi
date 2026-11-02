// Tests of a client host with its plugins (slice 11 §2, §4, decisions "Slice 11, P4" to "P6"), over an in-memory link
// to a server serving the scripts object: the initial scripts loaded with the core facets, a new set applied in place
// (only changed scripts fetched; a failed one keeps its old facet), a new base or an outdated server ending the client.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import * as chordNext from "../../src/index.ts";
import {
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

/** A registered script of plugin `plugin` (digest `digest`) serving `Greeting` with `text`; `broken` throws instead. */
function script(plugin: string, digest: string, text: string): RegisteredScript {
	return {
		plugin,
		digest,
		run: (require, module) => {
			if (text === "broken") throw new Error("broken plugin");
			const chord = require("@test/chord") as typeof chordNext;
			const facet = chord.defineFacet((host) => host.serve(Greeting, () => ({ text: chord.constant(text) })));
			Object.assign(module, { exports: { default: facet } });
		},
	};
}

/** The set of `scripts` under base `base`. */
function setOf(base: string, scripts: readonly RegisteredScript[]): ScriptSet {
	return {
		base,
		combined: "/combined.js",
		plugins: scripts.map(({ plugin, digest }) => ({ name: plugin, digest, url: `/${plugin}.${digest}.js` })),
	};
}

/** A server serving `WebScripts` with `initial`, and a client started against it with `scripts` available to fetch. */
async function setup(initial: readonly RegisteredScript[], available: readonly RegisteredScript[] = []) {
	const server = createHost<TestPrincipal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		onError: () => {},
	});
	await server.load(
		[{ name: "chord.web", facet: scriptsFacet<TestPrincipal>("web", { set: setOf("B1", initial) }) }],
		context,
	);
	const fetched: string[] = [];
	const errors: chordNext.ClientError[] = [];
	const outdated: string[] = [];
	const sockets: { events: SocketEvents; link: chordNext.Link }[] = [];
	let serverBase = "B1";
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
			server.accept(theirs, { principal: { kind: "user", id: "u" } }, context);
			sockets.push({ events, link: mine });
			queueMicrotask(() => events.opened());
			return mine;
		},
		fetchScript: async (entry) => {
			fetched.push(entry.url);
			const found = available.find(({ plugin, digest }) => plugin === entry.name && digest === entry.digest);
			if (found === undefined) throw new Error(`no ${entry.url}`);
			return found;
		},
		serverBase: async () => serverBase,
		outdated: () => outdated.push("outdated"),
		environment: {
			now: () => Date.now(),
			after: (ms, callback) => {
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

describe("applying a new set in place", () => {
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

describe("outdated clients", () => {
	it("calls outdated for a set with another base", async () => {
		const { client, server, outdated } = await setup([]);
		await publishTo(server, "web", setOf("B2", []), context);
		await until(() => outdated.length === 1);
		await client.stop(context);
		await server.close(context);
	});

	it("asks the server's base before reconnecting: another one calls outdated and stops", async () => {
		const { client, server, outdated, sockets, setServerBase } = await setup([]);
		setServerBase("B2");
		sockets[0]!.link.close();
		await until(() => outdated.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(sockets).toHaveLength(1);
		await client.stop(context);
		await server.close(context);
	});
});
