// The MCP supervisor (plugins/mcp/instances.ts) on its own, with the stdio fixture (test/fixtures/mcp-server.mjs) and a
// short backoff: reconnects after a crash with the tools kept and the stderr only in the owner's error, tool-list
// changes, a close or restart while connecting, and the tools a reload's new supervisor starts with.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOwnerConfig } from "../../plugins/mcp/config.ts";
import type { Instance } from "../../plugins/mcp/contract.ts";
import { Instances } from "../../plugins/mcp/instances.ts";
import { place } from "../../plugins/mcp/placement.ts";
import { poll } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const BACKOFF = { firstMs: 20, maxMs: 200, stableMs: 60_000 };
const CLIENT = { name: "p2-test", version: "1" };
const SIGNAL = new AbortController().signal;
/** These instances run on the p2 host only. */
const NO_ENVIRONMENTS = (): never => {
	throw new Error("no environments in this test");
};
/** No HTTP servers either. */
const NO_OAUTH = (): never => {
	throw new Error("no OAuth servers in this test");
};

/** A supervisor running the fixture once for session s1 at a temporary directory; `env` added to its environment. */
function supervisor(t: { after(fn: () => unknown): void }, env: Record<string, string> = {}, seed: Instance[] = []) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "p2-mcp-instances-")));
	const log = join(root, "starts.log");
	const config = parseOwnerConfig(
		JSON.stringify({
			mcpServers: { files: { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_LOG: log, ...env } } },
		}),
	);
	const placement = place(
		config,
		[
			{
				session: "s1",
				location: { env: null, cwd: root },
				project: { kind: "none" },
				generation: 1,
				incarnation: "i",
			},
		],
		{},
		{ s1: [null] },
	);
	const instances = new Instances(CLIENT, BACKOFF, seed, NO_ENVIRONMENTS, NO_OAUTH);
	t.after(async () => {
		await instances.close();
		rmSync(root, { recursive: true, force: true });
	});
	const pids = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
	return { instances, placement, pids, id: [...placement.instances.keys()][0]! };
}

test("a locked session's lease gets only the servers its owner picked", () => {
	const config = parseOwnerConfig(JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }));
	const lease = (session: string) => ({
		session,
		location: { env: null, cwd: "/w" },
		project: { kind: "none" as const },
		generation: 1,
		incarnation: "i",
	});
	const lock = { mcp: ["b"], projectMcp: false, instructions: false, capabilities: [] };
	const placement = place(config, [lease("s1"), lease("s2")], {}, { s1: [null], s2: [null] }, { s2: lock });
	const servers = (session: string) =>
		[...(placement.leases.find((entry) => entry.lease.session === session)?.servers.keys() ?? [])].sort();
	assert.deepEqual(servers("s1"), ["a", "b"]);
	assert.deepEqual(servers("s2"), ["b"]);
});

/** Resolves with the instances once `predicate` holds for them. */
function when(instances: Instances, predicate: (list: Instance[]) => boolean): Promise<Instance[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(new Error(`timed out; last: ${JSON.stringify(instances.list()).slice(0, 400)}`));
		}, 10_000);
		const check = () => {
			const list = instances.list();
			if (!predicate(list)) return;
			clearTimeout(timer);
			stop();
			resolve(list);
		};
		const stop = instances.subscribe(check);
		check();
	});
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const exited = (pid: number) => poll(() => !alive(pid), 10_000, `process ${pid} to exit`);

test("a crashed server reconnects after the backoff with its tools kept; its stderr is the owner's only", async (t) => {
	const { instances, placement, pids, id } = supervisor(t);
	instances.reconcile(placement);
	await when(instances, (list) => list[0]?.status === "connected");
	await instances.call(id, "crash", {}, SIGNAL);
	const [down] = await when(instances, (list) => list[0]?.status !== "connected");
	assert.equal(down!.tools.length, 4);
	await assert.rejects(instances.call(id, "echo", {}, SIGNAL), (error: Error) => {
		assert.equal(error.message, 'MCP server "files" is not connected: the connection was lost');
		return true;
	});
	assert.match(down!.error ?? "", /stderr: fixture crashing on purpose/);
	await exited(pids()[0]!);
	const [back] = await when(instances, (list) => list[0]?.status === "connected");
	assert.equal(back!.tools.length, 4);
	assert.equal(back!.error, undefined);
	assert.equal(pids().length, 2);
	// A tool-list change refreshes the tools.
	await instances.call(id, "grow", {}, SIGNAL);
	await when(instances, (list) => list[0]!.tools.some((tool) => tool.name === "extra"));
});

test("close and restart end a connect under way", async (t) => {
	const { instances, placement, pids, id } = supervisor(t, { MCP_FIXTURE_HANG: "1" });
	instances.reconcile(placement);
	await poll(() => pids().length === 1, 10_000, "the server to start");
	assert.equal(instances.list()[0]!.status, "starting");
	instances.restart(id);
	await exited(pids()[0]!);
	await poll(() => pids().length === 2, 10_000, "the server to start again");
	await instances.close();
	await exited(pids()[1]!);
	assert.deepEqual(instances.list(), []);
});

test("a new supervisor lists the tools and instructions its predecessor listed until the server answers", async (t) => {
	const first = supervisor(t, { MCP_FIXTURE_HANG: "1" });
	const seed: Instance = {
		id: first.id,
		server: "files",
		source: "owner",
		location: null,
		runsOn: "host",
		status: "connected",
		tools: [{ name: "echo", inputSchema: { type: "object" } }],
		instructions: "Echoes.",
	};
	const instances = new Instances(CLIENT, BACKOFF, [seed], NO_ENVIRONMENTS, NO_OAUTH);
	t.after(() => instances.close());
	instances.reconcile(first.placement);
	// The prompt shows the summary from the instructions: it does not change while the server starts again.
	assert.deepEqual(
		instances
			.list()
			.map((instance) => [instance.status, instance.tools.map((tool) => tool.name), instance.instructions]),
		[["starting", ["echo"], "Echoes."]],
	);
});

test("an instance lists its configuration's description, trimmed", () => {
	const config = parseOwnerConfig(
		JSON.stringify({
			mcpServers: {
				a: { command: "a", description: "  Searches the docs. " },
				b: { command: "b", description: " " },
			},
		}),
	);
	const lease = {
		session: "s1",
		location: { env: null, cwd: "/w" },
		project: { kind: "none" as const },
		generation: 1,
		incarnation: "i",
	};
	const placement = place(config, [lease], {}, { s1: [null] });
	assert.deepEqual(
		[...placement.instances.values()].map((spec) => [spec.server, spec.description]),
		[
			["a", "Searches the docs."],
			["b", undefined],
		],
	);
});
