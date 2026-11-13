// MCP tools in a session worker, end to end with the fake provider: the worker leases the owner's servers at the
// session's location with the project `.pi/mcp.json` it read there, the `codemode` section lists each server's namespace
// with its description, `describeNamespace()` describes it, a code mode
// script's call returns the server's answer (the model is not offered the tools, as in pi), a relocation moves the
// lease, a subagent's own location is leased while it is not archived, and with code mode off `tool_search` loads the
// tools for the model.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Mcp } from "../../plugins/mcp/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult"),
	);
const text = (result: ToolResultMessage | undefined) =>
	(result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
/** The prompt sections in effect after the conversation's last request. */
const sections = (view: ConversationView | null | undefined): Record<string, string> => {
	const current: Record<string, string> = {};
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system") continue;
			for (const [key, value] of Object.entries(message.sections ?? {})) {
				if (value === null) delete current[key];
				else current[key] = value;
			}
		}
	return current;
};
/** A completed code mode result's output, after its "Script completed" header. */
const scriptOutput = (result: ToolResultMessage): string => {
	const match = /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/.exec(text(result));
	assert.ok(match, `a completed script's result: ${text(result)}`);
	return text(result).slice(match[0].length);
};

test(
	"a session's code mode scripts call MCP tools, and tool_search loads them without code mode",
	{ timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		writeFileSync(
			join(fixture.dataDir, "mcp.json"),
			JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [FIXTURE] } } }),
		);
		// The project at the session's cwd adds a server there and refuses an HTTP one.
		mkdirSync(join(fixture.workspace, ".pi"));
		writeFileSync(
			join(fixture.workspace, ".pi", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					lint: { command: process.execPath, args: [FIXTURE] },
					remote: { url: "https://example.com/mcp" },
				},
			}),
		);
		const owner = fixture.browser();
		const mcp = await holdIn(owner, Mcp, {}, "owner");
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "MCP" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		// The worker leases the session's location; the owner's and the project's servers connect there.
		const started = await until(
			mcp.instances,
			(instances) =>
				instances.length === 2 &&
				instances.every((item) => item.status === "connected" && item.location?.cwd === fixture.workspace),
		);
		assert.deepEqual(
			started.map((item) => [item.server, item.source]),
			[
				["files", "owner"],
				["lint", "project"],
			],
		);
		const instance = started[0];
		const [refused] = await until(mcp.errors, (errors) => errors.length > 0);
		assert.match(refused!, /\.pi\/mcp\.json: server "remote": HTTP servers are for the owner's mcp\.json/);
		let serial = 0;
		const call = async (prompt: string) => {
			const count = results(await until(chat.view, Boolean)).length;
			await chat.send({ text: prompt, requestId: `mcp-${++serial}` }, BACKGROUND_CONTEXT);
			return results(
				await until(
					chat.view,
					(view) => results(view).length > count && !(view?.docs["pi.live"] as { run?: unknown })?.run,
				),
			).at(-1)!;
		};
		// As in pi, the tools are for code mode scripts: the model is not offered them, and `tool_search` is not installed.
		const echo = async (said: string) => {
			const result = await call(`codemode return await tools.mcp__files__echo({ text: ${JSON.stringify(said)} });`);
			assert.equal(result.isError, false, text(result));
			return scriptOutput(result);
		};
		assert.equal(await echo("hello"), "echo: hello");
		const listing = sections(await until(chat.view, Boolean));
		assert.equal(listing.mcp_servers, undefined);
		assert.match(
			listing.codemode ?? "",
			/## mcp__files\nTools of the MCP server "files" \(find them with searchTools\(\)\)\.\n\n## mcp__lint\nTools of the MCP server "lint"/,
		);
		// The deferred MCP tools are never declared inline.
		assert.doesNotMatch(listing.codemode ?? "", /mcp__files__echo/);
		const described = await call('codemode return await describeNamespace("mcp__files");');
		assert.match(text(described), /"tools":\[[^\]]*"mcp__files__echo"/);
		assert.equal((await call(`mcp__files__echo ${JSON.stringify({ text: "hello" })}`)).isError, true);
		assert.equal((await call(`tool_search ${JSON.stringify({ query: "echo" })}`)).isError, true);
		// The session moves in place: the worker leases the new location (no project there) and gives up the old one.
		const moved = join(fixture.workspace, "moved");
		mkdirSync(moved);
		await sessions.relocate({ id: session.id, cwd: moved, env: null }, BACKGROUND_CONTEXT);
		const after = await until(
			mcp.instances,
			(instances) =>
				instances.length === 1 && instances[0]!.location?.cwd === moved && instances[0]!.status === "connected",
		);
		assert.notEqual(after[0]!.id, instance!.id);
		assert.equal(await echo("there"), "echo: there");
		// A subagent spawned with its own cwd (a commit of the subagent registry): its location is leased too, until it is
		// archived.
		const own = join(moved, "own");
		mkdirSync(own);
		await call(
			`subagent ${JSON.stringify({ action: "spawn", name: "own", message: "hi", cwd: "own", tools: ["bash"] })}`,
		);
		await until(mcp.instances, (instances) =>
			instances.some((item) => item.location?.cwd === own && item.status === "connected"),
		);
		await call(`subagent ${JSON.stringify({ action: "archive", name: "own" })}`);
		await until(mcp.instances, (instances) => instances.length === 1 && instances[0]!.location?.cwd === moved);
		// Code mode off: as pi falls back, `tool_search` loads the tools and the model calls them. The worker's settings
		// observer is asynchronous: turns go until one runs with `tool_search` installed.
		writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ codemode: false }));
		let found: ToolResultMessage | undefined;
		for (let attempt = 0; attempt < 20 && !(found && !found.isError); attempt++) {
			if (attempt > 0) await sleep(200);
			found = await call(`tool_search ${JSON.stringify({ query: "echo" })}`);
		}
		assert.equal(found?.isError, false, text(found));
		assert.match(text(found), /mcp__files__echo/);
		const echoed = await call(`mcp__files__echo ${JSON.stringify({ text: "hello" })}`);
		assert.equal(echoed.isError, false, text(echoed));
		assert.equal(text(echoed), "echo: hello");
		assert.deepEqual(echoed.details, { server: "files", tool: "echo" });
	},
);
