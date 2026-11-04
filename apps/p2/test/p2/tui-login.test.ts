import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import loginServer from "../../plugins/login/server.ts";
import loginTui from "../../plugins/login/tui.ts";
import { ModelConfig, ModelResources } from "../../plugins/models/contract.ts";
import { Resources } from "../../plugins/models/resources.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { snapshotRuntime } from "../../src/tui/snapshot.ts";
import { nativeFacet, poll, testHost, until } from "./helpers.ts";

const SECRET = "sk-fixture-SECRET-42";
const CODE = "private-pasted-code";

async function setup(t: { after(fn: () => unknown): void }) {
	const directory = await mkdtemp(join(tmpdir(), "p2-tui-login-"));
	const pasted: string[] = [];
	const resources = new Resources({
		directory,
		createModels: (credentials, modelsStore) => {
			const models = createModels({ credentials, modelsStore });
			const faux = fauxProvider({ api: "test-tui-login" });
			models.setProvider({
				...faux.provider,
				auth: {
					apiKey: {
						name: "Fixture key",
						login: async (interaction) => ({
							type: "api_key",
							key: await interaction.prompt({ type: "secret", message: "Fixture key" }),
						}),
						resolve: async () => undefined,
					},
					oauth: {
						name: "Fixture OAuth",
						login: async (interaction) => {
							interaction.notify({ type: "auth_url", url: "https://example.test/login?state=x" });
							pasted.push(
								await interaction.prompt({ type: "manual_code", message: "Paste code or final redirect URL" }),
							);
							await interaction.prompt({
								type: "select",
								message: "Account",
								options: [{ id: "account", label: "Fixture account" }],
							});
							return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 600_000 };
						},
						refresh: async (credential) => credential,
						toAuth: async (credential) => ({ apiKey: credential.access }),
					},
				},
			});
			return models;
		},
	});
	await resources.start();
	const server = await testHost({
		facets: [nativeFacet(ModelResources, { resources }), loginServer],
		stubs: [
			[
				ModelConfig,
				(_input, _principal, self) => {
					const summary = self.state({
						models: [],
						defaultModel: null,
						errors: [],
					});
					const snapshot = self.state(resources.snapshot());
					return { summary, snapshot, setDefault: () => {}, setEnabledModels: () => {} };
				},
			],
		],
	});
	t.after(async () => {
		await server.close();
		await resources.close();
		await rm(directory, { recursive: true, force: true });
	});
	// A remote owner: the server offers the manual code paste (no reachable localhost callback).
	const client = await server.clientWith({ kind: "owner", access: "relay" }, [
		{ name: "tui-core", facet: tuiCoreFacet },
		{ name: "tui-login", facet: loginTui },
	]);
	const terminal = new VirtualTerminal(100, 30);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (data) => {
		writes.push(data);
		write(data);
	};
	const tui = new TuiAltScreen(terminal);
	const runtime = new TuiRuntime(client, tui);
	runtime.connected = true;
	runtime.role = "owner";
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true };
	};
	await runtime.start();
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	tui.start();
	t.after(() => {
		tui.stop();
		runtime.dispose();
	});
	const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
	const send = (data: string) => terminal.sendInput(data);
	const watcher = client.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	await whenLive(watcher);
	assert(watcher.variant === "owner");
	t.after(() => watcher.release());
	return { runtime, screen, send, writes, grants, pasted, resources, watcher };
}

test("/login with a secret: masked while typed, never echoed, not in the snapshot or status lines", async (t) => {
	const { runtime, screen, send, writes, resources } = await setup(t);
	await poll(() => runtime.commands.list().some((item) => item.slash === "login"));
	assert(runtime.ctx.commands.runSlash("/login faux"));
	await poll(async () => (await screen()).includes("Fixture key"));
	send("\r");
	await poll(async () => (await screen()).includes("Hidden as you type"));
	for (const char of SECRET.slice(0, 8)) send(char);
	// A paste goes in whole, still masked.
	send(`\x1b[200~${SECRET.slice(8)}\x1b[201~`);
	await poll(async () => (await screen()).includes("•".repeat(SECRET.length)));
	send("\r");
	await poll(async () => (await screen()).includes("✓"));
	assert.equal(resources.snapshot().credentials[0]?.type, "api_key");
	assert(!writes.join("").includes(SECRET.slice(0, 6)), "never rendered");
	assert(!JSON.stringify(snapshotRuntime(runtime)).includes(SECRET.slice(0, 6)), "not in the reload snapshot");
	assert(!runtime.notices.some((notice) => notice.text.includes(SECRET.slice(0, 6))), "not in status lines");
	send("\r");
	await poll(async () => !(await screen()).includes("Login to"));
});

test("/login OAuth remotely: the launcher opens and copies the address; the manual code completes it", async (t) => {
	const { runtime, screen, send, grants, pasted, watcher } = await setup(t);
	await poll(() => runtime.commands.list().some((item) => item.slash === "login"));
	runtime.ctx.commands.runSlash("/login");
	await poll(async () => (await screen()).includes("Select provider to login"));
	send("\r");
	await poll(async () => (await screen()).includes("Fixture OAuth"));
	send("\x1b[B");
	send("\r");
	await poll(async () => (await screen()).includes("https://example.test/login?state=x"));
	await poll(async () => (await screen()).includes("Paste code or final redirect URL"));
	send("\x0f");
	send("\x18");
	await poll(() => grants.length === 2);
	assert.deepEqual(grants, [
		["openUrl", { kind: "external", url: "https://example.test/login?state=x" }],
		["copy", { text: "https://example.test/login?state=x", label: "the sign-in address" }],
	]);
	for (const char of CODE) send(char);
	send("\r");
	await poll(async () => (await screen()).includes("Fixture account"));
	send("\r");
	await poll(async () => (await screen()).includes("✓"));
	assert.deepEqual(pasted, [CODE]);
	send("\x1b");
	await until(watcher.login, (state) => state === null);
});

test("cancel and dismiss: Escape cancels a running login, the next Escape closes and clears it; closing ends it", async (t) => {
	const { runtime, screen, send, watcher } = await setup(t);
	await poll(() => runtime.commands.list().some((item) => item.slash === "login"));
	runtime.ctx.commands.runSlash("/login faux");
	await poll(async () => (await screen()).includes("Fixture OAuth"));
	send("\x1b[B");
	send("\r");
	await poll(async () => (await screen()).includes("Paste code"));
	send("\x1b");
	await until(watcher.login, (state) => state?.status === "cancelled");
	send("\x1b");
	await until(watcher.login, (state) => state === null);
	assert(!runtime.contexts().has("overlay"));
	// A closed overlay (navigation, reload) also ends the flow.
	runtime.ctx.commands.runSlash("/login faux");
	await poll(async () => (await screen()).includes("Fixture OAuth"));
	send("\x1b[B");
	send("\r");
	await until(watcher.login, (state) => state?.status === "working");
	runtime.closeOverlays();
	await until(watcher.login, (state) => state === null);
	// /logout lists stored credentials (this fixture's provider list never changes, so there are none).
	runtime.ctx.commands.runSlash("/logout");
	await poll(() => runtime.notices.some((notice) => notice.text.startsWith("No stored provider credentials")));
});
