import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import {
	authenticateTui,
	endedNotice,
	forgetGuest,
	parseTuiArgs,
	readConfig,
	resumeAfterEnded,
	saveConfig,
	type TuiConfig,
} from "../../src/hosts/tui-config.ts";
import { holdIn, poll, startFixture, until } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;

/**
 * Plays the TLS-terminating tunnel of a remote origin: forwards HTTP and upgrades to the server as `https://<host>`
 * (Host and Origin rewritten), so loopback's device-owner rule does not apply.
 */
async function tunnel(t: { after(fn: () => unknown): void }, port: number, host: string): Promise<URL> {
	const rewrite = (headers: IncomingHttpHeaders, local: string): IncomingHttpHeaders => ({
		...headers,
		host,
		...(headers.origin === local ? { origin: `https://${host}` } : {}),
	});
	const server = createServer((request, response) => {
		const local = `http://${request.headers.host}`;
		const forward = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: request.method,
				path: request.url,
				headers: rewrite(request.headers, local),
			},
			(upstream) => {
				response.writeHead(upstream.statusCode ?? 502, upstream.headers);
				upstream.pipe(response);
			},
		);
		request.pipe(forward);
	});
	server.on("upgrade", (request, socket, head) => {
		const headers = rewrite(request.headers, `http://${request.headers.host}`);
		const upstream = connect(port, "127.0.0.1", () => {
			upstream.write(
				`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(headers)
					.map(([key, value]) => `${key}: ${value}`)
					.join("\r\n")}\r\n\r\n`,
			);
			upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert(address && typeof address === "object");
	return new URL(`http://127.0.0.1:${address.port}`);
}
const TOKEN = "a".repeat(43);

test("--join takes the origin from its link or must match the URL argument", () => {
	const link = `https://share.test/join/${TOKEN}`;
	const parsed = parseTuiArgs(["--join", link], {});
	assert.equal(parsed.url.origin, "https://share.test");
	assert.equal(parsed.joinLink, link);
	assert.equal(parsed.ownerLink, undefined);
	assert.equal(parseTuiArgs(["https://share.test", "--join", link], {}).url.origin, "https://share.test");
	assert.throws(() => parseTuiArgs(["https://other.test", "--join", link], {}), /share link for this origin/);
	assert.throws(() => parseTuiArgs(["--join", "http://share.test/join/x"], {}), /HTTPS/);
	assert.throws(() => parseTuiArgs(["--join", `https://share.test/join/${TOKEN}?x=1`], {}), /share link/);
	assert.throws(
		() => parseTuiArgs(["--join", link, "--owner-link", `https://share.test/owner#${"f".repeat(64)}`], {}),
		/either/,
	);
	// The environment's owner link never mixes into a join.
	assert.equal(parseTuiArgs(["--join", link], { P2_TUI_OWNER_LINK: "x" }).ownerLink, undefined);
});

test("remote guest: mixed prompt redeems a share link, restart reuses the cookie, ended shares re-prompt", async (t) => {
	const url = new URL("https://share.test");
	const config: TuiConfig = { connections: {} };
	let admitted = true;
	const requests: { path: string; method: string; redirect?: string; cookie: string | null; origin: string | null }[] =
		[];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const headers = new Headers(init?.headers);
			const path = new URL(String(input)).pathname;
			requests.push({
				path,
				method: init?.method ?? "GET",
				redirect: init?.redirect,
				cookie: headers.get("cookie"),
				origin: headers.get("origin"),
			});
			if (path === "/owner/check") return new Response("", { status: 401 });
			if (path === "/__p2_tui") return new Response(null, { status: admitted ? 200 : 403 });
			assert.equal(path, "/join");
			const body = JSON.parse(String(init?.body)) as { token: string; name: string };
			if (body.token !== TOKEN)
				return Response.json({ error: "This share has ended\x1b]52;c;x\x07" }, { status: 400 });
			return Response.json(
				{ session: "shared-session" },
				{
					headers: headers.get("cookie")
						? {}
						: { "Set-Cookie": "p2_guest_443=guest.secret; HttpOnly; SameSite=Strict; Path=/; Secure" },
				},
			);
		},
	);
	const prompts: string[] = [];
	const answers = [`${url.origin}/join/${TOKEN}`, "  ", "Ada\x1b[31m Lovelace"];
	const admission = await authenticateTui({ url }, config, async (kind) => {
		prompts.push(kind);
		return answers.shift()!;
	});
	assert.deepEqual(prompts, ["link", "name", "name"], "an empty name is asked again");
	assert.deepEqual(admission, { cookie: "p2_guest_443=guest.secret", role: "guest", session: "shared-session" });
	const redeemed = requests.find((request) => request.path === "/join")!;
	assert.equal(redeemed.origin, "https://share.test");
	assert.equal(redeemed.redirect, "error");
	assert.equal(redeemed.cookie, null);
	assert(!JSON.stringify(config).includes(TOKEN), "the invitation is never stored");

	const directory = mkdtempSync(join(tmpdir(), "p2-tui-guest-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	saveConfig(config, directory);
	const restarted = await authenticateTui({ url }, readConfig(directory), async () => {
		throw new Error("Unexpected prompt");
	});
	assert.equal(restarted.role, "guest");
	assert.equal(requests.at(-1)?.cookie, "p2_guest_443=guest.secret");
	assert(requests.every((request) => request.redirect === "error"));

	// Rejoining with the same link keeps the identity: the stored cookie goes along and is kept.
	const again = await authenticateTui(
		{ url, joinLink: `${url.origin}/join/${TOKEN}` },
		readConfig(directory),
		async () => "Ada",
	);
	assert.equal(again.cookie, "p2_guest_443=guest.secret");
	assert.equal(requests.at(-1)?.cookie, "p2_guest_443=guest.secret");

	// The share was reset: the stored cookie is forgotten and the prompt returns; join errors are one plain line.
	admitted = false;
	const reread = readConfig(directory);
	await assert.rejects(
		authenticateTui({ url }, reread, async (kind) =>
			kind === "link" ? `${url.origin}/join/${"b".repeat(43)}` : "Ada",
		),
		(error: Error) => error.message === "This share has ended]52;c;x",
	);
	assert.equal(reread.connections[url.origin]?.guest, undefined);
	forgetGuest(config, url.origin);
	assert.equal(config.connections[url.origin]?.guest, undefined);
});

test("a refused reconnect: the stored cookie kind decides the notice, which cookie is forgotten and the prompt", async () => {
	const url = new URL("https://share.test");
	const both = (): TuiConfig => ({
		connections: { [url.origin]: { cookie: "owner=x", guest: { cookie: "p2_guest_1=a.b", session: "s" } } },
	});
	assert.equal(endedNotice("guest"), "This share has ended.");
	assert.equal(endedNotice("owner"), "Signed out on this device.");
	const guestConfig = both();
	const questions: string[] = [];
	const answers = [`https://other.test/join/${TOKEN}`, `${url.origin}/join/${TOKEN}`];
	const next = await resumeAfterEnded("guest", url, guestConfig, async (question) => {
		questions.push(question);
		return answers.shift()!;
	});
	assert.deepEqual(next, { joinLink: `${url.origin}/join/${TOKEN}` });
	assert.match(questions[0]!, /new share link/);
	assert.match(questions[1]!, /share link for this origin.*Try again/);
	assert.deepEqual(guestConfig.connections[url.origin], { cookie: "owner=x" }, "only the guest cookie is forgotten");

	const ownerConfig = both();
	const owner = `${url.origin}/owner#${"f".repeat(64)}`;
	assert.deepEqual(await resumeAfterEnded("owner", url, ownerConfig, async () => owner), { ownerLink: owner });
	assert.deepEqual(ownerConfig.connections[url.origin], { guest: { cookie: "p2_guest_1=a.b", session: "s" } });
	assert.equal(await resumeAfterEnded("guest", url, both(), async () => "  "), undefined, "Enter quits");
});

test("loopback stays the device owner: a stored guest cookie never downgrades it", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
	const config: TuiConfig = { connections: { [url.origin]: { guest: { cookie: "p2_guest_1=x.y", session: "s" } } } };
	const admission = await authenticateTui({ url }, config, async () => {
		throw new Error("Unexpected prompt");
	});
	assert.deepEqual(admission, { role: "owner" });
});

test(
	"a guest joins by link with a name, sees its session as a guest, and the launcher ends on revocation",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture({
			allowedHosts: ["tui.test"],
		});
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		assert(links![0]!.url.startsWith("https://tui.test/join/"));
		const url = await tunnel(t, fixture.server.port, "tui.test");
		const config: TuiConfig = { connections: {} };
		const joinLink = `${url.origin}${new URL(links![0]!.url).pathname}`;
		const admission = await authenticateTui({ url, joinLink }, config, async () => "TUI guest");
		assert.equal(admission.role, "guest");
		assert.equal(admission.session, session.id);
		assert.match(admission.cookie ?? "", /^p2_guest_\d+=/);

		const terminal = new VirtualTerminal(100, 30);
		let ended = 0;
		let exited = 0;
		const client = await startTuiClient({
			terminal,
			url,
			credentials: { cookie: admission.cookie },
			pollMs: 100,
			reconnectMs: 20,
			colorQueryMs: 10,
			onAccessEnded: () => ended++,
			onExit: () => exited++,
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(
			async () => (await screen()).includes("guest · TUI guest (unverified) · view only"),
			20000,
			"guest header",
		);
		await poll(async () => ((await client.snapshot()) as { session?: string }).session === session.id);
		assert(
			!JSON.stringify(await client.snapshot()).includes(admission.cookie!),
			"the cookie never reaches the worker",
		);

		// The owner resets the link: the guest's connection ends and the launcher confirms it itself.
		await sharing.link({ mode: "view", reset: true }, BACKGROUND_CONTEXT);
		await poll(() => ended === 1, 15000, "access ended");
		assert.equal(exited, 1);
	},
);
