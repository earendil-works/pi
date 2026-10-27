// Entry 8: awaited gets. `host.get` and `ctx.get` resolve once the reference is ready; abort, the ctx closing and the
// host's `readyTimeout` reject them and release only that reference.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { type Ctx, createHost, type Host, hostNamed, isChordError, memoryLinkPair, remote } from "../src/index.ts";
import { CountingLink } from "./fixtures/counting.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	assert.ok(check(), "condition not reached");
}

const Slow = remote("t.e8-slow", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: { main: { state: { n: Type.Number() } } },
});

/** A server whose `Slow` object goes live when `open()` is called; a browser whose link counts frames. */
function setup(readyTimeout?: number) {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	server.serve(Slow, (_input, _principal, self) => {
		self.resource("gate", { version: 1, open: () => opened });
		return { variant: "main", n: self.state("n", Type.Number(), 1) };
	});
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: { user: "u" } });
	const link = new CountingLink(up);
	const browser: Host = createHost({
		self: { kind: "host" },
		name: "browser",
		kind: "client",
		upstream: { link, principal: { kind: "server" } },
		onError: () => {},
		...(readyTimeout === undefined ? {} : { readyTimeout }),
	});
	return { server, browser, link, open };
}

describe("awaited gets", () => {
	it("an aborted get rejects and releases only its reference; the binding stays for the others", async () => {
		const { server, browser, link, open } = setup();
		const abort = new AbortController();
		const first = browser.get(Slow, {}, { signal: abort.signal });
		const second = browser.get(Slow, {});
		await sleep(5);
		abort.abort();
		await assert.rejects(first, (error) => isChordError(error, "aborted"));
		await sleep(5);
		assert.equal(link.count("sent", "release"), 0, "the other awaiting get keeps the hold");
		open();
		const ref = await second;
		assert.equal(ref.n.value, 1);
		assert.equal(link.count("sent", "hold"), 1);
		ref.release();
		await until(() => link.count("sent", "release") === 1);
		await server.close();
	});

	it("a ctx.get still waiting when its call settles rejects aborted and releases its reference", async () => {
		const { server, browser, link, open } = setup();
		let pending: Promise<unknown> | undefined;
		await browser.root(async (ctx: Ctx) => {
			pending = ctx.get(Slow, {});
			pending.catch(() => {});
		});
		await assert.rejects(pending!, (error) => isChordError(error, "aborted"));
		await until(() => link.count("sent", "release") === 1);
		open();
		await server.close();
	});

	it("a get times out after readyTimeout with ready_timeout and releases its hold", async () => {
		const { server, browser, link } = setup(30);
		await assert.rejects(
			browser.get(Slow, {}),
			(error) => isChordError(error, "unavailable") && error.reason === "ready_timeout",
		);
		await until(() => link.count("sent", "release") === 1);
		await server.close();
	});

	it("ctx.get resolves hydrated; the call's reference is released when the call ends", async () => {
		const { server, browser, link, open } = setup();
		open();
		const value = await browser.root(async (ctx: Ctx) => {
			const slow = await ctx.get(Slow, {});
			return slow.n.value;
		});
		assert.equal(value, 1);
		await until(() => link.count("sent", "release") === 1);
		await server.close();
	});
});
