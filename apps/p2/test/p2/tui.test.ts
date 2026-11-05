import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import modelsTui from "../../plugins/models/tui.ts";
import { PROXY_MARKER_HEADER } from "../../plugins/proxy-marker/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui from "../../plugins/sessions/tui.ts";
import {
	authenticateTui,
	claimOwner,
	connectionHeaders,
	parseTuiArgs,
	readConfig,
	saveConfig,
} from "../../src/hosts/tui-config.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { poll, startFixture, testHost, until } from "./helpers.ts";

const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");

test("TUI auth options, private config and owner-claim cookie round trip", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-tui-config-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	assert.equal(parseTuiArgs([], {}).url.origin, "http://127.0.0.1:8788");
	assert.equal(
		parseTuiArgs([], { PORT: "9000", P2_PUBLIC_URL: "https://remote.test" }).url.origin,
		"http://127.0.0.1:9000",
	);
	const link = `https://example.test/owner#${"a".repeat(64)}`;
	assert.equal(parseTuiArgs(["https://example.test", "--owner-link", link], {}).ownerLink, link);
	assert.throws(
		() => parseTuiArgs(["https://example.test", "--basic-auth", "fixture:password"], {}),
		/Unknown TUI option/,
	);
	assert.throws(() => parseTuiArgs(["https://elsewhere.test", "--owner-link", link], {}), /this origin/);
	assert.throws(
		() => parseTuiArgs(["https://example.test", "--owner-link", "https://example.test/owner?token=secret"], {}),
		/fragment/,
	);
	assert.throws(() => parseTuiArgs(["http://remote.test"], {}), /HTTPS/);
	assert.throws(() => parseTuiArgs(["https://fixture:secret@example.test"], {}), /without credentials/);
	// Through Radius: optionally the server's ID; Radius admits the owner, so no URL or link, and no owner link from env.
	const radiusServer = "0b5a3e8e-6f1d-4c55-9d3a-2a7b1c9e4f10";
	assert.deepEqual(parseTuiArgs(["--radius"], {}).radius, {});
	assert.deepEqual(parseTuiArgs(["--radius", radiusServer, "--theme", "dark"], {}).radius, { server: radiusServer });
	assert.equal(parseTuiArgs(["--radius"], { P2_TUI_OWNER_LINK: link }).ownerLink, undefined);
	assert.throws(() => parseTuiArgs(["--radius", "https://example.test"], {}), /no URL/);
	assert.throws(() => parseTuiArgs(["https://example.test", "--radius", "--owner-link", link], {}), /no URL/);
	saveConfig({ connections: { "https://example.test": { cookie: "owner=fixture" } } }, directory);
	assert.equal(statSync(join(directory, "config.json")).mode & 0o777, 0o600);
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	assert.equal(readConfig(directory).connections["https://example.test"]?.cookie, "owner=fixture");
	const headers = connectionHeaders(new URL("https://example.test"), {
		cookie: "owner=fixture",
	});
	assert.equal(headers.Origin, "https://example.test");
	assert.equal(headers.Cookie, "owner=fixture");
	assert.equal(headers.Authorization, undefined);
	const server = createServer((request, response) => {
		assert.equal(request.headers.origin, `http://127.0.0.1:${port}`);
		assert.equal(request.url, "/owner/claim");
		assert.equal(request.method, "POST");
		let body = "";
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => {
			assert.equal(JSON.parse(body).token, "fixture-token");
			response.writeHead(200, { "Set-Cookie": "owner=fixture; HttpOnly; Path=/" });
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const port = address.port;
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	assert.equal((await claimOwner(new URL(`http://127.0.0.1:${port}`), "fixture-token", {})).cookie, "owner=fixture");
});

test("TUI loopback automatically signs in as the device owner without a link prompt", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
	const token = (await fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
	const associated = await claimOwner(url, token, {});
	const config = { connections: { [url.origin]: associated } };
	const credentials = await authenticateTui({ url }, config, async () => {
		throw new Error("Unexpected owner link prompt");
	});
	assert.deepEqual(credentials, { role: "owner" }, "loopback uses the device path, not a cached remote cookie");
	const client = fixture.client(connectionHeaders(url, credentials)).host;
	const devices = client.hold(Devices, {}, BACKGROUND_CONTEXT);
	assert.equal(await until(devices.canMint, (value) => value === true), true);
});

test("a proxy marker refuses the TUI automatic path and falls back to a link prompt", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const original = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const headers = new Headers(init?.headers);
		headers.set(PROXY_MARKER_HEADER, "1");
		return original(input, { ...init, headers });
	});
	let prompted = false;
	await assert.rejects(
		authenticateTui({ url: new URL(`http://127.0.0.1:${fixture.server.port}`) }, { connections: {} }, async () => {
			prompted = true;
			throw new Error("Link prompt required");
		}),
		/Link prompt required/,
	);
	assert(prompted);
});

test("remote TUI prompts for an owner link, saves only its cookie, and reuses valid saved credentials", async (t) => {
	const url = new URL("https://tui.example.test");
	const token = "f".repeat(64);
	const config = { connections: {} };
	let claims = 0;
	t.mock.method(
		globalThis,
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const path = new URL(String(input)).pathname;
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			if (path === "/owner/check") return new Response('{"owner":true}');
			assert.equal(path, "/owner/claim");
			assert.equal(JSON.parse(String(init?.body)).token, token);
			claims++;
			return new Response("{}", {
				headers: { "Set-Cookie": "owner=fixture; HttpOnly; Secure; SameSite=Lax; Path=/" },
			});
		},
	);
	const credentials = await authenticateTui({ url }, config, async () => `${url.origin}/owner#${token}`);
	assert.equal(credentials.cookie, "owner=fixture");
	assert(!JSON.stringify(config).includes(token));
	const directory = mkdtempSync(join(tmpdir(), "p2-tui-link-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	saveConfig(config, directory);
	assert.equal(statSync(join(directory, "config.json")).mode & 0o777, 0o600);
	await authenticateTui({ url }, readConfig(directory), async () => {
		throw new Error("Unexpected repeat prompt");
	});
	assert.equal(claims, 1);
});

test("bare-host TUI facets register, render session/model pickers and reload without a server", async (t) => {
	const session: Session = {
		id: "fixture-session",
		cwd: "/fixture",
		title: "Fixture session",
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		pinned: false,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		main: 1,
		branches: [],
	};
	let configured = "";
	const fixture = await testHost({
		facets: [tuiCoreFacet, sessionsTui, modelsTui],
		stubs: [
			[
				Sessions,
				(_input, _principal, self) => {
					const sessions = self.state([session]);
					const defaultCwd = self.state("/fixture");
					const defaultEnv = self.state(null);
					return {
						variant: "owner",
						sessions,
						defaultCwd,
						defaultEnv,
						operations: self.state([]),
						dismissOperation: () => {},
						create: () => session,
						relocate: () => {},
						rename: () => {},
						pin: () => {},
						archive: () => {},
						clone: () => {
							throw new Error("not in this test");
						},
						fork: () => {
							throw new Error("not in this test");
						},
						restore: () => {},
					};
				},
			],
			[
				Models,
				(_input, _principal, self) => {
					const models = self.state([
						{
							provider: "faux",
							modelId: "faux-1",
							name: "Fixture model",
							thinkingLevels: ["off"],
							contextWindow: 128000,
						},
					]);
					const resources = self.state({
						version: 1,
						settings: {},
						credentials: [],
						providers: [],
						models: [],
						errors: [],
					});
					const defaultModel = self.state(null);
					const errors = self.state([]);
					const enabledModels = self.state([]);
					const scopedModels = self.state([]);
					return {
						variant: "owner",
						models,
						resources,
						defaultModel,
						errors,
						enabledModels,
						scopedModels,
						setEnabledModels: () => {},
						setDefault: (choice: { modelId: string }) => {
							configured = choice.modelId;
						},
					};
				},
			],
		],
	});
	t.after(() => fixture.close());
	const terminal = new VirtualTerminal(70, 24);
	const tui = new TuiAltScreen(terminal);
	const runtime = new TuiRuntime(fixture.host, tui);
	runtime.connected = true;
	runtime.role = "owner";
	await runtime.start();
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	tui.start();
	t.after(() => {
		tui.stop();
		runtime.dispose();
	});
	await poll(() => plain(runtime.render(70)).includes("Fixture session"));
	assert.match(plain(runtime.render(70)), /New session/);
	runtime.handleInput("\x1b[B");
	runtime.handleInput("\r");
	assert.equal(runtime.session, session.id);
	// pi's model selector as an overlay; without a session it sets the default for new sessions.
	runtime.session = undefined;
	runtime.navigate("sessions");
	const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
	await poll(async () => {
		if (!runtime.ctx.commands.run("app.model.select")) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
		if ((await screen()).includes("faux-1")) return true;
		terminal.sendInput("\x1b");
		return false;
	});
	assert.match(await screen(), /Choose default model for new sessions/);
	terminal.sendInput("\r");
	await poll(() => configured === "faux-1");
	await fixture.reload([tuiCoreFacet, sessionsTui, modelsTui]);
	runtime.navigate("sessions");
	await poll(() => plain(runtime.render(70)).includes("Fixture session"));
	assert.deepEqual(fixture.errors, []);
});
