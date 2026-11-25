// The TUI launcher through Radius (src/hosts/tui-radius.ts). Its own file: the launcher's memory watchdog measures the
// whole process, which in radius.test.ts also holds every earlier test's servers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { radiusTransport } from "../../src/hosts/tui-radius.ts";
import { poll } from "./helpers.ts";
import { radiusFixture as fixture } from "./radius-fixture.ts";

test(
	"the TUI through Radius loads the server's bundle and opens its chord link",
	{ skip: Number(process.versions.node.split(".")[0]) < 26, timeout: 60_000 },
	async (t) => {
		const f = await fixture(t, undefined, { channels: true });
		const transport = radiusTransport(
			{ gateway: f.radius.gateway, access: async () => "fixture-token" },
			randomUUID(),
		);
		const terminal = new VirtualTerminal(100, 30);
		const failures: string[] = [];
		const client = await startTuiClient({
			terminal,
			url: new URL("https://radius.invalid"),
			transport,
			colorQueryMs: 10,
			onFailure: (message) => failures.push(message),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 20_000, "sessions over the chord link");
		assert.equal(client.connected, true);
		assert.deepEqual(failures, []);
	},
);
